# ZK_MedTrust

A backend that runs real chest X-rays through a real pretrained diagnostic model via
ONNX, with a Streamlit demo UI, and (eventually) produces a zero-knowledge proof of
the model's claimed accuracy via SnarkJS.

**This is a research-grade demo, not a clinical device.** The model is real, trained
on real public medical data — but nothing here is validated for diagnostic use.

## What exists

**`backend/requirements.txt`** — runtime deps: `streamlit`, `fastapi`, `uvicorn`,
`onnxruntime`, `numpy`, `pillow`, `requests`, `python-multipart`, `onnx`.
`torch`/`torchvision`/`torchxrayvision` are deliberately excluded — they're only
needed once, to export the ONNX model (see below), and pulling them into every
deploy's `pip install` would be wasteful and slow.

**`backend/ml_inference.py`** — `MedicalDiagnosticsModel` class wrapping an ONNX
Runtime session around **torchxrayvision's `densenet121-res224-all`**: a DenseNet-121
trained by researchers on real chest X-ray datasets (NIH ChestX-ray14, CheXpert,
MIMIC-CXR, PadChest, RSNA) to detect 18 real pathologies (Atelectasis, Cardiomegaly,
Effusion, Pneumonia, etc.). Apache 2.0 licensed.
- `predict(image_path)` →
  `{"prediction": "Normal"|"Abnormal", "confidence": float, "model": "...", "findings": [{"pathology": str, "score": float}, ...]}`,
  findings sorted descending by score.
- On first use, if `backend/models/densenet121_xrv.onnx` doesn't exist, it's generated
  by `_export_model()`. **Important export detail**: the model's `forward()` normally
  applies `sigmoid` + `op_norm()` when `op_threshs` is set, and `op_norm()` uses
  boolean-mask tensor assignment — which traces to data-dependent ONNX ops
  (`NonZero`/`ScatterND`), breaking the static-shape graph this project wants for a
  future ZK circuit. So `_export_model` captures `pathologies` + `op_threshs` from the
  live model, sets `model.op_threshs = None` (making `forward()` return raw logits),
  exports *that*, and writes the captured metadata to a sidecar
  `backend/models/xrv_meta.json`. `predict()` replicates `sigmoid` + `op_norm` in pure
  numpy at inference time — verified to match the real PyTorch pipeline's final scores
  closely (checked against 3 real X-rays; see below).
- Preprocessing replicates xrv's pipeline in PIL/numpy (no `scikit-image` at runtime):
  grayscale via plain channel mean (not PIL luma weighting), scale to `[-1024, 1024]`,
  center-crop to square, resize to 224×224 with `Image.BILINEAR` + `reducing_gap=2.0`
  (chosen after comparing against skimage's anti-aliased resize — this combination
  came closest across a 512×512 and a 2373×2373 test image; max per-pathology score
  deviation from the real skimage-based pipeline was ~3-6%, never enough to flip a
  prediction across the 0.5 decision boundary in testing).
- `torch`/`torchxrayvision` are imported lazily *inside* `_export_model`, so the
  module imports fine at runtime with only `onnxruntime`/`numpy`/`pillow` installed.
- `python backend/ml_inference.py` downloads 3 real sample chest X-rays from
  torchxrayvision's repo into `data/` (only if `data/` has no images yet — **your own
  X-rays dropped into `data/` are used as-is and never overwritten**), then runs
  `predict()` on every image found there.

**`backend/app.py`** — FastAPI server, CORS open to all origins. Unchanged by the
real-model swap (it just passes `predict()`'s dict straight through).
- `GET /health` → `{"status": "ok"}`
- `POST /predict` — multipart file upload → temp file → `model.predict()` → temp file
  deleted → `{"status": "success", "prediction": {...}}` or
  `{"status": "error", "message": "..."}`. Model loaded once at module import.
- `POST /generate_proof` — accepts `{"claimed_accuracy": int, "correct": int, "total": int}`,
  currently just echoes it back as `{"status": "success", "proof": {...}, "claimed_accuracy": int}`.
  **Still a stub** — no actual proof is generated yet; real SnarkJS/circom work is a
  separate, not-yet-started piece.
- `python backend/app.py` runs uvicorn on `0.0.0.0:8000`.

**`frontend/streamlit_app.py`** — demo UI, `streamlit run frontend/streamlit_app.py`.
Sidebar explains the problem (locked medical data) / solution (ZK proofs). Left column:
upload → preview → Run Inference → Prediction/Confidence metrics → top-5 findings
table. Right column: Generate ZK Proof (disabled until inference runs) → proof JSON →
Verify Proof → "✓ Proof Valid" + balloons. State persists via `st.session_state`
across Streamlit reruns. Calls the FastAPI endpoints over HTTP at
`http://localhost:8000`.
- The `/generate_proof` payload is synthesized from a single image's confidence
  (`claimed_accuracy = round(confidence*100)`, `correct: 1, total: 1`) since there's
  no ground truth in this UI flow — a placeholder until real accuracy claims exist.

## Not yet built

- Real SnarkJS/circom proof generation behind `/generate_proof` (currently an echo
  stub).
- The `/generate_proof` payload needs rethinking once proofs are real — an accuracy
  claim needs a labeled evaluation set, not one unlabeled prediction.
- Tests.

## Setup gotchas learned the hard way

- First run of `ml_inference.py` needs `torchxrayvision` installed
  (`pip install torchxrayvision`, not in requirements.txt — pulls in
  `torch`/`torchvision`/`scikit-image` too) to export the ONNX model. Once
  `backend/models/densenet121_xrv.onnx` + `xrv_meta.json` exist, it's not needed
  again.
- `POST /predict` needs `python-multipart` installed or FastAPI raises at route
  registration time — it's in requirements.txt now.
- `backend/models/*.onnx`, `backend/models/*.json`, and `data/*.png`/`*.jpg`/`*.jpeg`
  are gitignored (generated/downloaded artifacts, not committed).
- `requirements.txt` pins `streamlit==1.28.0`→now `>=1.28.0`; the exact pin had no
  prebuilt wheel for this machine's Python 3.14 and pip fell back to a slow/failing
  source build. Changed to `>=` deliberately (hackathon priority: compatibility over
  pinning).
- No `claude-in-chrome` browser tool is available in this environment; UI testing here
  was done with `playwright` (`pip install --user playwright`, pointed at the system's
  `/usr/bin/chromium-browser` via `executable_path=` — no extra browser download
  needed) driving upload → inference → proof → verify and screenshotting each step.
