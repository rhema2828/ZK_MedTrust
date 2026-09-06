"""PHASE 4 - evaluation pipeline.

Runs the EXISTING MedicalDiagnosticsModel (backend/ml_inference.py, not
touched by this file at all) over the records Phase 3 selected, compares
each prediction to that record's ground-truth label, and aggregates
correct_predictions / total_predictions for Phase 5's accuracy circuit.

    build/selection.json (Phase 3: which records, and their Merkle proofs)
                    |
                    v
    for each selected record:
        verify the image file's SHA-256 still matches what was committed
        (Phase 2) -- catches a record silently swapped after commitment,
        before it ever reaches the model
                    |
                    v
        MedicalDiagnosticsModel.predict(image)  <- the EXISTING model, as-is
                    |
                    v
        compare prediction to ground_truth -> correct (0 or 1)
                    |
                    v
    correct_predictions, total_predictions  -> build/evaluation.json

IMPORTANT - read before trusting any number this script prints:

  The ground_truth labels AND images in data/sample_dataset.json are
  SYNTHETIC placeholders (see make_synthetic_images.py), assigned/generated
  so this pipeline has something concrete to compare predictions against.
  They are not real diagnoses or real X-rays. The model itself IS real and
  trained (torchxrayvision's densenet121-res224-all, see CLAUDE.md) - but
  the "correct_predictions" this script reports is still not a medically
  meaningful accuracy figure, because what's being fed to it is synthetic.
  What Phases 4-6 demonstrate is real: a real trained model runs, produces
  real (deterministic) outputs, which get compared and counted the same way
  real evaluation data would be. Only the images and labels being compared
  against are synthetic, and that is stated everywhere this number is
  printed or written, not just here.
"""

import argparse
import hashlib
import json
import sys
from pathlib import Path

ZK_DIR = Path(__file__).resolve().parent.parent
PROJECT_ROOT = ZK_DIR.parent
BACKEND_DIR = PROJECT_ROOT / "backend"
DATA_DIR = ZK_DIR / "data"
BUILD_DIR = ZK_DIR / "build"

# ml_inference.py is not a package (no __init__.py) - app.py itself imports
# it the same way, by adding backend/ to sys.path and doing a plain
# `import ml_inference`. Mirroring that exactly means this file does not
# need backend/ to change in any way.
sys.path.insert(0, str(BACKEND_DIR))


def verify_image_integrity(image_path: Path, expected_sha256: str) -> bool:
    """Recompute an image file's SHA-256 and compare to what Phase 2 committed to.

    This is the same content-hash check the Merkle leaf itself encodes
    (see zk/merkle/canonicalize.mjs) - running it again here, right before
    inference, means a record whose image file was swapped out after the
    commitment was published gets caught before the model ever sees it,
    rather than only being theoretically detectable via the Merkle proof.
    """
    actual = hashlib.sha256(image_path.read_bytes()).hexdigest()
    return actual == expected_sha256


def score_prediction(prediction: str, ground_truth: str) -> int:
    """1 if the model's prediction matches the record's ground truth, else 0."""
    return 1 if prediction == ground_truth else 0


def aggregate(results: list[dict]) -> tuple[int, int]:
    """(correct_predictions, total_predictions) over a list of per-record results."""
    total = len(results)
    correct = sum(r["correct"] for r in results)
    return correct, total


def load_dataset_by_record_id(dataset_path: Path) -> dict:
    records = json.loads(dataset_path.read_text())
    by_id = {r["record_id"]: r for r in records}
    if len(by_id) != len(records):
        raise ValueError("dataset has duplicate record_id values")
    return by_id


def run_evaluation(selection_path: Path, dataset_path: Path, images_dir: Path) -> dict:
    selection = json.loads(selection_path.read_text())
    dataset_by_id = load_dataset_by_record_id(dataset_path)

    # Imported here, not at module load time, so that importing this module
    # for its pure helper functions (score_prediction, aggregate, ...) in
    # tests never requires onnxruntime/numpy/pillow to be installed.
    from ml_inference import MedicalDiagnosticsModel

    model = MedicalDiagnosticsModel()

    per_record = []
    for entry in selection["selected_records"]:
        record_id = entry["record_id"]
        record = dataset_by_id.get(record_id)
        if record is None:
            raise ValueError(f"selection references record_id {record_id!r} not present in {dataset_path}")

        image_path = images_dir / f"{record_id}.png"
        if not image_path.exists():
            raise FileNotFoundError(f"missing image for {record_id}: {image_path}")

        if not verify_image_integrity(image_path, record["image_sha256"]):
            raise ValueError(
                f"INTEGRITY FAILURE: {image_path} does not match the SHA-256 committed "
                f"for {record_id} in {dataset_path}. Refusing to evaluate a record whose "
                f"image content no longer matches the Merkle commitment."
            )

        result = model.predict(image_path)
        correct = score_prediction(result["prediction"], record["ground_truth"])

        per_record.append({
            "index": entry["index"],
            "record_id": record_id,
            "ground_truth": record["ground_truth"],
            "prediction": result["prediction"],
            "confidence": result["confidence"],
            "model": result["model"],
            "correct": correct,
        })

    correct_predictions, total_predictions = aggregate(per_record)

    return {
        "synthetic_data_warning": (
            "ground_truth labels and images are SYNTHETIC placeholders (see "
            "zk/evaluation/make_synthetic_images.py) - these numbers are NOT a "
            "medically meaningful accuracy figure, regardless of the model "
            "being real and trained. See CLAUDE.md and zk/README.md."
        ),
        "root": selection["root"],
        "dataset_version": selection["dataset_version"],
        "sample_size": selection["sample_size"],
        "model": per_record[0]["model"] if per_record else None,
        "per_record": per_record,
        "correct_predictions": correct_predictions,
        "total_predictions": total_predictions,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--selection", type=Path, default=BUILD_DIR / "selection.json",
        help="Phase 3 output (default: zk/build/selection.json)",
    )
    parser.add_argument(
        "--dataset", type=Path, default=DATA_DIR / "sample_dataset.json",
        help="dataset file with ground_truth labels (default: zk/data/sample_dataset.json)",
    )
    parser.add_argument(
        "--images", type=Path, default=DATA_DIR / "images",
        help="directory of {record_id}.png files (default: zk/data/images)",
    )
    args = parser.parse_args()

    if not args.selection.exists():
        print(f"Missing {args.selection} - run sampling/selectFromCommitment.mjs first.", file=sys.stderr)
        sys.exit(1)

    evaluation = run_evaluation(args.selection, args.dataset, args.images)

    BUILD_DIR.mkdir(parents=True, exist_ok=True)
    out_path = BUILD_DIR / "evaluation.json"
    out_path.write_text(json.dumps(evaluation, indent=2))

    print("=" * 60)
    print(" SYNTHETIC DATA - see synthetic_data_warning in the output")
    print("=" * 60)
    for r in evaluation["per_record"]:
        mark = "correct" if r["correct"] else "WRONG"
        print(f"  [{r['index']}] {r['record_id']}: predicted={r['prediction']!r} "
              f"ground_truth={r['ground_truth']!r} confidence={r['confidence']:.3f}  ({mark})")
    print("-" * 60)
    print(f"  correct_predictions = {evaluation['correct_predictions']}")
    print(f"  total_predictions   = {evaluation['total_predictions']}")
    print(f"Wrote {out_path}")


if __name__ == "__main__":
    main()
