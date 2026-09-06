"""ONNX Runtime inference for a ResNet-18-based medical image classifier."""

import json
import os
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image

PROJECT_ROOT = Path(__file__).resolve().parent.parent
MODEL_PATH = PROJECT_ROOT / "backend" / "models" / "resnet18.onnx"
IMAGE_SIZE = 224
CLASSES = ("Normal", "Abnormal")
IMAGENET_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
IMAGENET_STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)


def _export_model(path: Path) -> None:
    """Export a ResNet-18 backbone with a seeded 2-class head to ONNX."""
    try:
        import torch
        import torch.nn as nn
        from torchvision.models import ResNet18_Weights, resnet18
    except ImportError as exc:
        raise ImportError(
            "Exporting the model requires torch and torchvision. "
            "Install them with: pip install torch torchvision"
        ) from exc

    model = resnet18(weights=ResNet18_Weights.DEFAULT)
    torch.manual_seed(42)
    model.fc = nn.Linear(512, 2)
    model.eval()

    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_suffix(".tmp")
    dummy_input = torch.randn(1, 3, IMAGE_SIZE, IMAGE_SIZE)
    torch.onnx.export(
        model,
        dummy_input,
        str(tmp_path),
        dynamo=False,
        opset_version=17,
        input_names=["input"],
        output_names=["logits"],
    )
    os.replace(tmp_path, path)


class MedicalDiagnosticsModel:
    """Wraps an ONNX Runtime session for binary medical image classification."""

    def __init__(self, model_path: Path = MODEL_PATH):
        model_path = Path(model_path)
        if not model_path.exists():
            _export_model(model_path)

        self.session = ort.InferenceSession(
            str(model_path), providers=["CPUExecutionProvider"]
        )
        self.input_name = self.session.get_inputs()[0].name

    def _preprocess(self, image_path: Path) -> np.ndarray:
        image = Image.open(image_path).convert("RGB")
        if image.size != (IMAGE_SIZE, IMAGE_SIZE):
            image = image.resize((IMAGE_SIZE, IMAGE_SIZE))

        array = np.asarray(image).astype(np.float32) / 255.0
        array = (array - IMAGENET_MEAN) / IMAGENET_STD
        array = array.transpose(2, 0, 1)
        return np.expand_dims(array, axis=0).astype(np.float32)

    def predict(self, image_path) -> dict:
        image_path = Path(image_path)
        if not image_path.exists():
            raise FileNotFoundError(f"Image not found: {image_path}")

        input_tensor = self._preprocess(image_path)
        logits = self.session.run(None, {self.input_name: input_tensor})[0][0]

        exp_logits = np.exp(logits - np.max(logits))
        probabilities = exp_logits / exp_logits.sum()
        class_index = int(np.argmax(probabilities))

        return {
            "prediction": CLASSES[class_index],
            "confidence": float(probabilities[class_index]),
            "model": "ResNet-18",
        }


def _make_synthetic_xray(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    gradient = np.linspace(20, 200, IMAGE_SIZE, dtype=np.uint8)
    array = np.tile(gradient, (IMAGE_SIZE, 1))

    array[60:100, 60:100] = 240
    array[140:170, 130:180] = 30

    Image.fromarray(array, mode="L").convert("RGB").save(path)


if __name__ == "__main__":
    image_path = PROJECT_ROOT / "data" / "synthetic_xray.png"
    if not image_path.exists():
        _make_synthetic_xray(image_path)

    model = MedicalDiagnosticsModel()
    result = model.predict(image_path)
    print(json.dumps(result, indent=2))
