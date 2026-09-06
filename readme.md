# ZK-MedTrust

A hospital can prove *"our AI model hit at least X% accuracy on our
evaluation data"* — without showing anyone the patient images, the
individual predictions, or even how many cases were tested. The proof is
mathematical, not a promise: anyone can check it, and it cannot be faked.

This is a research/hackathon-scale demo of that idea, built with real
cryptography and a real (if not clinically validated) chest X-ray model —
not a mockup. Below is what it actually does, explained simply. For full
technical depth per phase — algorithms, exact commands, public/private
input tables — see **[`zk/README.md`](zk/README.md)**.

## What are we proving?

One statement:

```
correct_predictions * 100 >= threshold * total_predictions
```

In plain terms: *"the fraction of correct predictions is at least
`threshold` percent."* This is a **threshold** claim ("at least X%"), not an
exact-accuracy claim — a hospital can prove it cleared a bar without
revealing exactly where it landed above that bar.

## What's public, what's private

| | |
|---|---|
| **Public** (the verifier sees this) | `total_predictions` (how many cases were evaluated), `threshold` (the bar being claimed) |
| **Private** (never leaves the prover) | `correct_predictions` (exactly how many were right) |

`total_predictions` has to be public, or a hospital could just claim
`total_predictions = 1` and trivially "prove" 100% accuracy on nothing.
`threshold` has to be public — it's literally the claim being checked. Only
the exact correct-count stays hidden.

## The pieces, in plain terms

**Dataset commitment (the Merkle root).** Before running any evaluation, the
hospital publishes one number — a *Merkle root* — that's a cryptographic
fingerprint of the entire evaluation dataset (every record's ID, the SHA-256
of its image, its ground-truth label). Change even one record afterward and
the root changes. This stops a hospital from quietly swapping in an easier
dataset after the fact, or editing results post-hoc: whatever gets evaluated
has to match what was already committed to.

**Bound sampling (why the hospital can't cherry-pick).** Instead of letting
the hospital choose which records to actually test, the specific sample is
derived deterministically from the published root itself
(`SHA256(root | dataset_version | sample_size)`). Nobody — not even the
hospital — can quietly re-roll the sample until they land on a favorable
one, because there's no hidden randomness left to vary.

**Evaluation.** The real model (see below) runs on the selected sample.
Each image's hash is re-checked against the Merkle commitment right before
inference, so a record swapped in after publishing the root gets caught.

**Groth16 (what the proof actually is).** [Groth16](https://en.wikipedia.org/wiki/Non-interactive_zero-knowledge_proof)
is the specific zero-knowledge proof system used here (via
[Circom](https://circom.io) to define the statement and
[SnarkJS](https://github.com/iden3/snarkjs) to generate/verify proofs). It
lets someone prove they know private values (`correct_predictions`)
satisfying a public equation, without revealing those values. Verification
is fast and doesn't require re-running anything — the verifier checks a
short proof against the public inputs and a fixed verification key.

**A property worth understanding, not glossing over:** the arithmetic above
is genuinely enforced by the circuit — a false claim cannot even produce a
proof, not just "produces a proof that fails verification." Everything
*around* that (the Merkle commitment, the bound sampling, the image-hash
check) is real too, but enforced by ordinary code, not by the SNARK itself.
`zk/README.md`'s Phase 6 section spells out exactly which guarantee comes
from which layer — that distinction matters and is easy to blur by accident.

## How to generate and verify a proof

```bash
# one-time setup
pip install -r backend/requirements.txt
pip install torchxrayvision                 # for the model export, see below
cd zk && bash scripts/install_toolchain.sh && bash scripts/ptau.sh
bash scripts/phase5_accuracy.sh              # compiles the circuit, runs Groth16 setup
cd ..

# run the API (needs ZK_API_KEY and ZK_TICKET_SECRET set)
export ZK_API_KEY=dev-key
export ZK_TICKET_SECRET=dev-secret
python backend/app.py
```

```bash
# generate a proof that 90/100 correct clears an 85% threshold
curl -X POST http://localhost:8000/generate_proof \
  -H "X-API-Key: dev-key" -H "Content-Type: application/json" \
  -d '{"claimed_accuracy": 85, "correct": 90, "total": 100}'

# verify a proof (paste the proof + public_signals from the response above)
curl -X POST http://localhost:8000/verify_proof \
  -H "X-API-Key: dev-key" -H "Content-Type: application/json" \
  -d '{"proof": {...}, "public_signals": [...]}'
# -> {"zk_verified": true}
```

A false claim (e.g. `correct` doesn't actually meet `claimed_accuracy`)
returns `422` from `/generate_proof` — there is no proof to generate for a
false statement, by construction. See `zk/README.md`'s per-phase sections
for the full picture, including the standalone Circom scripts if you want
to see the raw proof/verify cycle without the API in between.

## What the ML model does NOT prove

The chest X-ray model (`backend/ml_inference.py`, torchxrayvision's
`densenet121-res224-all`) is a real model trained on real public chest X-ray
datasets — not a placeholder. But:

- **It is not clinically validated.** Nothing here is cleared for diagnostic
  use. Treat its output the way you'd treat any research model's output.
- **The ZK proof doesn't validate the model, the data, or the model's
  correctness.** It proves a mathematical statement about supplied
  evaluation results — *if* you evaluate this model on this dataset, *then*
  the resulting counts satisfy this inequality. It says nothing about
  whether the dataset was representative, or whether the model is any good
  in general.
- Keep these three ideas separate: **ML inference** (does the model produce
  a prediction), **evaluation** (was that prediction compared honestly to a
  ground truth), and **cryptographic proof** (was the resulting arithmetic
  claim proven without cheating). The proof only covers the third one.

## Everything else in this repo

- **`backend/`** — FastAPI server + the ONNX model wrapper. `POST /predict`
  runs real inference on an uploaded X-ray.
- **`frontend/`** — a Streamlit demo UI wrapping the API end to end.
- **`zk/`** — the full zero-knowledge layer described above. Ten phases,
  each with its own section in `zk/README.md`: toolchain sanity, Merkle
  commitment, bound sampling, evaluation, the accuracy circuit, wiring it
  together, the real API endpoints, a security layer (API keys, rate
  limiting, replay-protected tickets), a 120-test matrix, and this document.
- **`CLAUDE.md`** — a working-notes file for AI coding assistants picking
  this project back up; not written for a human audience, but thorough.

Run everything at once with `bash run_all_tests.sh` from the repo root.
