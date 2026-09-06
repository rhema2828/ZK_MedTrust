# ZK_MedTrust — Progress Summary

Current branch: `zk-layer` (not yet merged to `main`, not yet pushed to GitHub).

## 1. Backend (`backend/`)

**`backend/ml_inference.py`** — `MedicalDiagnosticsModel` class wrapping an ONNX
Runtime session around **torchxrayvision's `densenet121-res224-all`**: a real
DenseNet-121 trained on real chest X-ray datasets (NIH ChestX-ray14, CheXpert,
MIMIC-CXR, PadChest, RSNA), detecting 18 real pathologies (Atelectasis,
Cardiomegaly, Effusion, Pneumonia, etc.). Apache 2.0 licensed.

- `predict(image_path)` → `{"prediction": "Normal"|"Abnormal", "confidence": float, "model": str, "findings": [{"pathology": str, "score": float}, ...]}`
- Exports its own ONNX model on first use (`_export_model()`), capturing the
  model's classification thresholds into a sidecar JSON and replicating
  `sigmoid` + threshold-normalization in pure numpy — done specifically to
  keep the exported ONNX graph static-shaped (no data-dependent ops), which
  matters for the ZK circuit work below.
- Verified against real chest X-rays (2 from NIH ChestX-ray14, 1 COVID case
  from a public radiology dataset): predictions and top pathology matched a
  reference PyTorch pipeline in every case, no threshold flips.
- This is a **research-grade demo, not a clinical device** — real trained
  weights, but nothing here is validated for diagnostic use.

**`backend/app.py`** — FastAPI server, CORS open to all origins.
- `GET /health` → `{"status": "ok"}`
- `POST /predict` — multipart image upload → real model inference → JSON result
- `POST /generate_proof` — **still a stub**, echoes its input back; real
  SnarkJS/circom proof generation is not wired in yet (see ZK layer below)

## 2. Frontend (`frontend/streamlit_app.py`)

Streamlit demo UI: sidebar explains the problem (locked medical data) and
solution (ZK proofs). Upload an X-ray → preview → Run Inference → prediction,
confidence, and top-5 pathology findings → Generate ZK Proof (currently calls
the stub) → proof JSON → Verify Proof → success state. Tested end-to-end with
Playwright driving headless Chromium (no browser extension available in this
environment) — the full upload-to-verify flow works.

## 3. Zero-Knowledge Layer (`zk/`)

Real Circom + SnarkJS + Groth16 work. Originally built in a separate sandboxed
session (which couldn't push to GitHub or reach the model's weights host), and
merged into this branch from a git bundle, then **verified for real on this
machine** and extended with a new phase.

- **Phase 1 — toolchain sanity.** `zk/circuits/square.circom` proves `x*x=y`.
  Real Groth16 proof generated and verified; tampering with the public input
  and with the proof itself are both correctly rejected.
- **Phase 2 — Merkle dataset commitment.** `zk/merkle/`: canonicalizes each
  evaluation record, hashes it, builds a Merkle tree (Poseidon), produces a
  root and inclusion proofs. Deterministic — same dataset always yields the
  same root.
- **Phase 3 — cryptographically bound sampling.** `zk/sampling/`: sample
  indices are derived deterministically from `SHA256(root | dataset_version |
  sample_size)`, so a prover can't privately re-roll samples until they get a
  favorable one.
- **Phase 4 — evaluation pipeline.** `zk/evaluation/evaluate.py` runs the real
  `MedicalDiagnosticsModel` over the sampled records, re-verifying each
  image's SHA-256 against the Merkle commitment before inference. Ran
  end-to-end against the real model on this machine. A test that was silently
  skipping (hardcoded to check for a model file that no longer exists after
  the model swap) was found and fixed — now genuinely passes.
- **Phase 5 — accuracy ZK circuit** (built this session).
  `zk/circuits/accuracy.circom` proves:

  ```
  correct_predictions * 100 >= threshold * total_predictions
  ```

  a **threshold** claim ("accuracy >= threshold%"), not an equality claim.
  `total_predictions` and `threshold` are public inputs; `correct_predictions`
  is private. `total_predictions` must be public — otherwise a prover could
  claim `total_predictions = 1` and trivially satisfy any threshold. Every
  value is explicitly range-checked (`Num2Bits`) before being compared, since
  circomlib's comparators are only sound when inputs are pre-constrained to
  fit their bit-width — skipping that is a known class of circom bug. All
  four constraints (`0 < total`, `0 <= correct <= total`, `0 <= threshold <=
  100`, the accuracy inequality) are hard constraints: violating any of them
  means no witness can be generated at all, not just that a proof gets
  rejected later.
- **Phases 6–10 — not started.** Wiring Merkle + sampling + ZK together, real
  `/generate_proof` + `/verify_proof` in the FastAPI backend, a security layer
  (API keys, rate limiting, HMAC tickets), the full test matrix, and final
  documentation. See the roadmap table at the bottom of `zk/README.md`.

**Test status:** 43/43 JavaScript tests passing (`npm test` in `zk/`), 13/13
Python tests passing (`python -m unittest zk/evaluation/test_evaluate.py -v`
from the repo root).

## 4. Known loose ends

- `HANDOFF_PROMPT.md` and `zkmedtrustphases14.bundle` (the git bundle used to
  bring the ZK layer branch in) got swept into git history by the merge
  commit — these are one-time handoff artifacts, not project files, and
  probably shouldn't stay in permanent history long-term.
- Nothing has been pushed to GitHub yet.
- `/generate_proof`'s current payload (`claimed_accuracy`, `correct: 1,
  total: 1`) is a placeholder — a real accuracy claim needs a labeled
  evaluation set, not one unlabeled prediction. This will need rethinking
  once Phase 7 wires the real circuit into the API.
