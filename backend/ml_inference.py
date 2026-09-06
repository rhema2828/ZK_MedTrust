"""ONNX Runtime inference for a real chest X-ray diagnostic model.

Uses torchxrayvision's densenet121-res224-all: a DenseNet-121 trained by
researchers on real chest X-ray datasets (NIH ChestX-ray14, CheXpert, MIMIC-CXR,
PadChest, RSNA) to detect 18 real pathologies. This is a research-grade model,
not a clinically validated diagnostic device.
"""

import json
import os
import urllib.request
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image

PROJECT_ROOT = Path(__file__).resolve().parent.parent
MODEL_PATH = PROJECT_ROOT / "backend" / "models" / "densenet121_xrv.onnx"
META_PATH = PROJECT_ROOT / "backend" / "models" / "xrv_meta.json"
DATA_DIR = PROJECT_ROOT / "data"
IMAGE_SIZE = 224
ABNORMAL_THRESHOLD = 0.5

SAMPLE_XRAYS = {
    "00000001_000.png": "https://raw.githubusercontent.com/mlmed/torchxrayvision/main/tests/00000001_000.png",
    "00027426_000.png": "https://raw.githubusercontent.com/mlmed/torchxrayvision/main/tests/00027426_000.png",
    "covid-19-pneumonia-58-prior.jpg": "https://raw.githubusercontent.com/mlmed/torchxrayvision/main/tests/covid-19-pneumonia-58-prior.jpg",
}


def _export_model(onnx_path: Path, meta_path: Path) -> None:
    """Export torchxrayvision's densenet121-res224-all to ONNX.

    The model's forward() applies sigmoid + op_norm() when op_threshs is set,
    and op_norm() uses boolean-mask tensor assignment, which traces to
    data-dependent ONNX ops (NonZero/ScatterND). That breaks the static-shape
    graph this project wants for a downstream ZK circuit. So op_threshs is
    captured then cleared before export, making forward() return raw logits;
    sigmoid + op_norm are replicated in numpy at inference time instead.
    """
    try:
        import torch
        import torchxrayvision as xrv
    except ImportError as exc:
        raise ImportError(
            "Exporting the model requires torchxrayvision. "
            "Install it with: pip install torchxrayvision"
        ) from exc

    model = xrv.models.DenseNet(weights="densenet121-res224-all")
    model.eval()

    pathologies = list(model.pathologies)
    op_threshs = model.op_threshs.detach().cpu().numpy().tolist()
    model.op_threshs = None

    onnx_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = onnx_path.with_suffix(".tmp")
    dummy_input = torch.randn(1, 1, IMAGE_SIZE, IMAGE_SIZE)
    torch.onnx.export(
        model,
        dummy_input,
        str(tmp_path),
        dynamo=False,
        opset_version=17,
        input_names=["input"],
        output_names=["logits"],
    )
    os.replace(tmp_path, onnx_path)

    meta_tmp = meta_path.with_suffix(".tmp")
    meta_tmp.write_text(
        json.dumps({"pathologies": pathologies, "op_threshs": op_threshs})
    )
    os.replace(meta_tmp, meta_path)


def _op_norm(sigmoid_scores: np.ndarray, op_threshs: np.ndarray) -> np.ndarray:
    """Numpy port of torchxrayvision's op_norm: remaps each pathology's score
    so its operating threshold sits at 0.5."""
    output = np.full_like(sigmoid_scores, 0.5)
    valid = ~np.isnan(op_threshs)
    below = (sigmoid_scores < op_threshs) & valid
    above = ~(sigmoid_scores < op_threshs) & valid

    output[below] = sigmoid_scores[below] / (op_threshs[below] * 2)
    output[above] = 1.0 - ((1.0 - sigmoid_scores[above]) / ((1 - op_threshs[above]) * 2))
    return output


class MedicalDiagnosticsModel:
    """Wraps an ONNX Runtime session for real chest X-ray pathology detection."""

    def __init__(self, model_path: Path = MODEL_PATH, meta_path: Path = META_PATH):
        model_path = Path(model_path)
        meta_path = Path(meta_path)
        if not model_path.exists() or not meta_path.exists():
            _export_model(model_path, meta_path)

        self.session = ort.InferenceSession(
            str(model_path), providers=["CPUExecutionProvider"]
        )
        self.input_name = self.session.get_inputs()[0].name

        meta = json.loads(meta_path.read_text())
        self.pathologies = meta["pathologies"]
        self.op_threshs = np.array(meta["op_threshs"], dtype=np.float32)

    def _preprocess(self, image_path: Path) -> np.ndarray:
        image = Image.open(image_path).convert("RGB")
        array = np.asarray(image).astype(np.float32).mean(axis=2)
        array = (2 * (array / 255.0) - 1.0) * 1024.0

        height, width = array.shape
        crop = min(height, width)
        top = height // 2 - crop // 2
        left = width // 2 - crop // 2
        array = array[top : top + crop, left : left + crop]

        resized = Image.fromarray(array, mode="F").resize(
            (IMAGE_SIZE, IMAGE_SIZE), Image.BILINEAR, reducing_gap=2.0
        )
        array = np.asarray(resized, dtype=np.float32)
        return array[np.newaxis, np.newaxis, :, :]

    def predict(self, image_path) -> dict:
        image_path = Path(image_path)
        if not image_path.exists():
            raise FileNotFoundError(f"Image not found: {image_path}")

        input_tensor = self._preprocess(image_path)
        logits = self.session.run(None, {self.input_name: input_tensor})[0][0]

        sigmoid_scores = 1.0 / (1.0 + np.exp(-logits))
        scores = _op_norm(sigmoid_scores, self.op_threshs)

        findings = sorted(
            (
                {"pathology": name, "score": float(score)}
                for name, score, thresh in zip(self.pathologies, scores, self.op_threshs)
                if name and not np.isnan(thresh)
            ),
            key=lambda f: f["score"],
            reverse=True,
        )

        top_score = findings[0]["score"] if findings else 0.0
        is_abnormal = top_score > ABNORMAL_THRESHOLD

        return {
            "prediction": "Abnormal" if is_abnormal else "Normal",
            "confidence": float(top_score if is_abnormal else 1.0 - top_score),
            "model": "DenseNet-121 (torchxrayvision densenet121-res224-all)",
            "findings": findings,
        }


def _fetch_sample_xrays(data_dir: Path) -> None:
    data_dir.mkdir(parents=True, exist_ok=True)
    existing = list(data_dir.glob("*.png")) + list(data_dir.glob("*.jpg")) + list(
        data_dir.glob("*.jpeg")
    )
    if existing:
        return

    for filename, url in SAMPLE_XRAYS.items():
        dest = data_dir / filename
        urllib.request.urlretrieve(url, dest)


if __name__ == "__main__":
    _fetch_sample_xrays(DATA_DIR)

    model = MedicalDiagnosticsModel()

    image_paths = sorted(
        list(DATA_DIR.glob("*.png"))
        + list(DATA_DIR.glob("*.jpg"))
        + list(DATA_DIR.glob("*.jpeg"))
    )
    for image_path in image_paths:
        result = model.predict(image_path)
        print(f"--- {image_path.name} ---")
        print(json.dumps(result, indent=2))
