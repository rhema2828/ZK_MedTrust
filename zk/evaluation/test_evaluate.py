"""PHASE 4 EVALUATION TESTS

Uses only Python's built-in unittest - no extra test dependency, matching
the "no dependency beyond what's already needed" approach zk/'s JS tests
take with node:test.

These exercise the comparison/aggregation/integrity logic directly and do
NOT require onnxruntime, numpy, pillow, or the exported ONNX model - they
are meant to run even before that (heavier, network-dependent) setup is
done. A separate, explicitly-named integration test covers the real
model.predict() path and is skipped automatically if the dependencies or
the model file aren't available.
"""

import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from evaluate import (  # noqa: E402
    aggregate,
    load_dataset_by_record_id,
    score_prediction,
    verify_image_integrity,
)


class ScorePredictionTests(unittest.TestCase):
    def test_correct_when_matching(self):
        self.assertEqual(score_prediction("Normal", "Normal"), 1)
        self.assertEqual(score_prediction("Abnormal", "Abnormal"), 1)

    def test_incorrect_when_not_matching(self):
        self.assertEqual(score_prediction("Normal", "Abnormal"), 0)
        self.assertEqual(score_prediction("Abnormal", "Normal"), 0)

    def test_is_case_sensitive_exact_match_no_fuzzy_logic(self):
        # Deliberately strict: "normal" != "Normal". No silent correction.
        self.assertEqual(score_prediction("normal", "Normal"), 0)


class AggregateTests(unittest.TestCase):
    def test_all_correct(self):
        results = [{"correct": 1}, {"correct": 1}, {"correct": 1}]
        self.assertEqual(aggregate(results), (3, 3))

    def test_mixed(self):
        results = [{"correct": 1}, {"correct": 0}, {"correct": 1}, {"correct": 0}]
        self.assertEqual(aggregate(results), (2, 4))

    def test_empty(self):
        self.assertEqual(aggregate([]), (0, 0))

    def test_none_correct(self):
        results = [{"correct": 0}, {"correct": 0}]
        self.assertEqual(aggregate(results), (0, 2))


class VerifyImageIntegrityTests(unittest.TestCase):
    def test_matching_hash_verifies(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "image.png"
            path.write_bytes(b"some image bytes")
            expected = hashlib.sha256(b"some image bytes").hexdigest()
            self.assertTrue(verify_image_integrity(path, expected))

    def test_swapped_file_content_fails(self):
        # This is the "record silently swapped after commitment" scenario -
        # same file path, different bytes, must be caught.
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "image.png"
            original_hash = hashlib.sha256(b"original bytes").hexdigest()
            path.write_bytes(b"DIFFERENT bytes, swapped after commitment")
            self.assertFalse(verify_image_integrity(path, original_hash))

    def test_wrong_hash_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "image.png"
            path.write_bytes(b"some bytes")
            self.assertFalse(verify_image_integrity(path, "0" * 64))


class LoadDatasetTests(unittest.TestCase):
    def test_indexes_by_record_id(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "dataset.json"
            path.write_text(json.dumps([
                {"record_id": "A", "ground_truth": "Normal"},
                {"record_id": "B", "ground_truth": "Abnormal"},
            ]))
            by_id = load_dataset_by_record_id(path)
            self.assertEqual(by_id["A"]["ground_truth"], "Normal")
            self.assertEqual(by_id["B"]["ground_truth"], "Abnormal")

    def test_rejects_duplicate_record_ids(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "dataset.json"
            path.write_text(json.dumps([
                {"record_id": "A", "ground_truth": "Normal"},
                {"record_id": "A", "ground_truth": "Abnormal"},
            ]))
            with self.assertRaises(ValueError):
                load_dataset_by_record_id(path)


class RealModelIntegrationTest(unittest.TestCase):
    """Runs the actual pipeline against the real MedicalDiagnosticsModel,
    end to end, exactly as evaluate.py's CLI does. Skipped (not failed) if
    the model/runtime dependencies aren't present, so the rest of the
    suite stays runnable without onnxruntime/numpy/pillow installed."""

    def test_run_evaluation_against_real_model(self):
        try:
            import onnxruntime  # noqa: F401
        except ImportError:
            self.skipTest("onnxruntime not installed - see zk/README.md Phase 4 setup")

        zk_dir = Path(__file__).resolve().parent.parent
        backend_dir = zk_dir.parent / "backend"
        sys.path.insert(0, str(backend_dir))
        from ml_inference import MODEL_PATH  # noqa: E402

        if not MODEL_PATH.exists():
            self.skipTest(
                f"{MODEL_PATH} not exported yet - run "
                "`python backend/ml_inference.py` first (needs torchxrayvision "
                "one-time, per CLAUDE.md)"
            )

        from evaluate import run_evaluation

        selection_path = zk_dir / "build" / "selection.json"
        dataset_path = zk_dir / "data" / "sample_dataset.json"
        images_dir = zk_dir / "data" / "images"
        if not selection_path.exists():
            self.skipTest(f"missing {selection_path} - run the Phase 2/3 CLIs first")

        evaluation = run_evaluation(selection_path, dataset_path, images_dir)

        total = evaluation["total_predictions"]
        correct = evaluation["correct_predictions"]
        self.assertEqual(total, len(evaluation["per_record"]))
        self.assertTrue(0 <= correct <= total)
        for r in evaluation["per_record"]:
            self.assertIn(r["prediction"], ("Normal", "Abnormal"))
            self.assertEqual(r["correct"], 1 if r["prediction"] == r["ground_truth"] else 0)


if __name__ == "__main__":
    unittest.main()
