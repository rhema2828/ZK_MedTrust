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

## Zero-Knowledge Layer (`zk/`)

Real Circom + SnarkJS + Groth16 work, being built in gated phases on branch
`claude/zk-medtrust-layer-tgpnhs`. Full detail, algorithms, and "try it" commands
are in `zk/README.md` — this is a summary of what exists so far so it doesn't have
to be rediscovered.

- **Phase 1 — toolchain sanity.** `zk/circuits/square.circom` proves `x*x=y`
  (`x` private, `y` public). `zk/scripts/install_toolchain.sh` builds `circom`
  v2.2.2 from source (not published to npm or crates.io, and GitHub Releases is
  blocked in this sandbox, so `cargo install` from a pinned git tag is the install
  path) and installs `snarkjs`. `zk/scripts/ptau.sh` generates a **local
  development** Powers-of-Tau ceremony (the real Hermez file is blocked here too)
  — loudly flagged everywhere as not a trusted setup. `zk/scripts/phase1_square.sh`
  proves, verifies (pass), then tampers with the public input and the proof
  separately and confirms both are rejected.
- **Phase 2 — Merkle dataset commitment.** `zk/merkle/`: a record is exactly
  `{record_id, image_sha256, ground_truth, dataset_version}` canonicalized to one
  fixed string; leaf = SHA-256(canonical) reduced into the BN254 scalar field; tree
  nodes combine with Poseidon (`circomlibjs` — same implementation circomlib's
  circuit template uses, so a path built here still checks out inside a circuit
  later). Padding uses the field element `0`, not a duplicated leaf (duplication
  lets two different datasets collide on one root). `image_sha256` commits to
  image *content*, not a path.
- **Phase 3 — cryptographically bound sampling.** `zk/sampling/`: sample indices
  are `SHA256(root | dataset_version | sample_size)` expanded with a counter —
  deterministic from public values already on the commitment, so a prover can't
  privately re-roll a sample until they get one they like. Documented limitation:
  this stops re-rolling a *fixed, published* dataset; it doesn't by itself stop
  shopping around for a different dataset before ever publishing a root (would
  need an external randomness beacon — not implemented).
- **Phase 4 — evaluation pipeline.** `zk/evaluation/evaluate.py` imports
  `backend/ml_inference.py` unmodified (same `sys.path` + `import ml_inference`
  pattern `app.py` already uses — `backend/` isn't a package) and runs the real
  model over Phase 3's selected records, re-verifying each image's SHA-256 against
  the Merkle commitment immediately before inference. `zk/data/sample_dataset.json`
  now has **real** synthetic images (`zk/evaluation/make_synthetic_images.py`,
  deterministic/reproducible) instead of Phase 2's original placeholder text-hash
  stand-ins — `dataset_version` bumped to `phase2-synthetic-demo-v2` accordingly,
  which intentionally changed the Merkle root. `ground_truth` labels are
  hand-assigned synthetic placeholders, so `correct_predictions` from this
  pipeline is explicitly **not** a medically meaningful figure regardless of how
  good the underlying model is — every place it's printed says so.
  - This section was written when `backend/ml_inference.py` still used an
    ImageNet ResNet-18 with an untrained random head, and the sandbox that built
    it couldn't reach `download.pytorch.org` to even export that model. Both are
    now moot: `ml_inference.py` was replaced with a real trained model (see
    above) before this branch was merged, and export/inference already works on
    this machine. `zk/evaluation/test_evaluate.py`'s real-model integration test
    has not yet been re-run against the new model — do that before trusting its
    13/13-pass claim below.
- **Phases 5–10 — not started.** Accuracy circuit
  (`correct*100 >= threshold*total`), wiring Merkle+sampling+ZK together, real
  `/generate_proof` + `/verify_proof`, the security layer (API keys, rate
  limiting, HMAC tickets), the full test matrix, and final docs. See the roadmap
  table at the bottom of `zk/README.md` for current status.

## Not yet built

- Real SnarkJS/circom proof generation *wired into the FastAPI backend* — the
  cryptography itself works (`zk/`, Phases 1–3 above), but `/generate_proof` is
  still the original echo stub and `/verify_proof` doesn't exist yet (Phase 7).
- The `/generate_proof` payload needs rethinking once proofs are real — an accuracy
  claim needs a labeled evaluation set, not one unlabeled prediction.
- Any frontend (`streamlit` is in requirements.txt but unused so far). Its
  "Verify Proof" button (`frontend/streamlit_app.py:104`) currently just sets a
  session flag on click — no real verification call. Needs fixing once
  `/verify_proof` exists (Phase 10 of the zk/ roadmap).
- Tests for `backend/` itself (`zk/` now has its own test suites — see above).

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
