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
    now moot: `ml_inference.py` was replaced with a real trained model before
    this branch was merged, and on this machine every step above has been
    re-run and verified for real: Phase 1's tamper tests pass, the Merkle
    root/sampling reproduce deterministically, `evaluate.py` runs the real
    model end-to-end, and `zk/evaluation/test_evaluate.py`'s real-model
    integration test — previously stale (hardcoded to check for the deleted
    `resnet18.onnx`, so it silently skipped) — was fixed to reference
    `ml_inference.MODEL_PATH` and now genuinely passes (13/13, 0 skipped).
- **Phase 5 — accuracy ZK circuit.** `zk/circuits/accuracy.circom` proves
  `correct_predictions * 100 >= threshold * total_predictions` (a threshold
  claim, not an equality) via circomlib's `LessThan`/`GreaterEqThan`, with
  every value explicitly `Num2Bits`-range-checked before comparison —
  circomlib's comparators are only sound when inputs are pre-constrained to
  fit their bit-width, a well-known circom footgun otherwise. `total_predictions`
  and `threshold` are public (total is already public via Phase 3's
  `sample_size`; making it private would let a prover fabricate `total=1` to
  trivially clear any threshold); `correct_predictions` is the one private
  input. All four constraints (`0<total`, `0<=correct<=total`, `0<=threshold<=100`,
  the accuracy inequality itself) are hard constraints — violating any of them
  means no witness can be generated at all, not just that a proof gets
  rejected. `zk/scripts/phase5_accuracy.sh` and `zk/test/accuracy.test.mjs`
  verify this: a genuine 90%-vs-85% claim proves and verifies, all four
  violating cases fail at witness generation, and a post-hoc public-input
  tamper is rejected (43/43 JS tests passing overall).
- **Phase 6 — connecting Merkle + sampling + ZK.** `zk/witness/buildWitness.mjs`
  turns Phase 4's real `correct_predictions`/`total_predictions` into Phase 5's
  circuit input (`correct_predictions`, `total_predictions`, `threshold` —
  the exact field names/public-private split `accuracy.circom` requires, not
  a guess). `zk/scripts/phase6_pipeline.sh` runs the full chain against a real
  evaluation run and correctly treats **both** outcomes as a pass: a claim the
  real result meets proves and verifies; a claim it doesn't meet correctly
  fails at witness generation (the circuit's hard-constraint guarantee, now
  demonstrated against real data instead of Phase 5's hand-typed numbers) —
  verified in both directions. `zk/README.md`'s Phase 6 section states plainly
  which properties are circuit-enforced (only the accuracy inequality) vs.
  protocol-enforced (image integrity, Merkle inclusion, sampling determinism).
- **Phase 8 — security layer.** `backend/security.py`, scoped to
  `/generate_proof` only (`/predict`/`/health` untouched): API key
  (`hmac.compare_digest`, fails closed if unconfigured), in-memory rate
  limiting, input validation mirroring the circuit's own range checks, HMAC
  tickets carrying a nonce + a *hash* of the request payload (never the
  payload itself — no patient data in tickets), secure temp-file handling,
  a model-integrity SHA-256 utility, and request IDs. `/generate_proof`'s
  body is still the Phase 4-era echo stub; Phase 7 replaces the inner logic
  without touching this gate again. 36/36 tests (`backend/test_security.py`),
  including live `fastapi.testclient` calls against the real route.
- **Phases 7, 9, 10 — not started.** Real `/generate_proof` body +
  `/verify_proof` (now has a real circuit to call into, per Phase 6), the
  full test matrix, and final docs. See the roadmap table at the bottom of
  `zk/README.md` for current status.

## Not yet built

- Real SnarkJS/circom proof generation *wired into the FastAPI backend* — the
  cryptography itself works (`zk/`, Phases 1–6 above) and `/generate_proof`
  now has a real security gate (Phase 8), but its body is still the original
  echo stub and `/verify_proof` doesn't exist yet (Phase 7).
- The `/generate_proof` payload needs rethinking once proofs are real — an accuracy
  claim needs a labeled evaluation set, not one unlabeled prediction.
- Any frontend (`streamlit` is in requirements.txt but unused so far). Its
  "Verify Proof" button (`frontend/streamlit_app.py:104`) currently just sets a
  session flag on click — no real verification call. Needs fixing once
  `/verify_proof` exists (Phase 10 of the zk/ roadmap).
- Tests for the rest of `backend/` beyond `security.py` (`/predict`,
  `ml_inference.py`) — `zk/` and `backend/test_security.py` now have their
  own test suites (see above), but `/predict` itself still doesn't.

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
