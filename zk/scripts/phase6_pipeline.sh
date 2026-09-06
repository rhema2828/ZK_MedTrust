#!/usr/bin/env bash
#
# PHASE 6 - orchestrates the full chain up to (and, once available, through)
# the accuracy circuit:
#
#   dataset -> Merkle root -> bound sample selection -> evaluation
#            -> witness assembly -> [accuracy circuit: setup/prove/verify]
#
# The last bracketed step only runs if zk/circuits/accuracy.circom exists.
# It does not exist in this checkout as of Phase 6 (it's being built
# separately - see zk/README.md). That is not a failure: this script
# reports it plainly and exits 0, describing the actual current state of
# the repo. The moment accuracy.circom lands, re-running this script picks
# it up automatically with no changes needed here.
#
set -euo pipefail

ZK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ZK_DIR"

DATASET="${DATASET:-data/sample_dataset.json}"
SAMPLE_SIZE="${SAMPLE_SIZE:-3}"
THRESHOLD="${THRESHOLD:-80}"
CIRCUIT="circuits/accuracy.circom"

hr() { echo; echo "=============================================================="; echo " $1"; echo "=============================================================="; }

hr "STEP 1  Merkle commitment (Phase 2)"
node merkle/commitDataset.mjs "$DATASET"

hr "STEP 2  Bound sample selection (Phase 3)"
node sampling/selectFromCommitment.mjs "$SAMPLE_SIZE"

hr "STEP 3  Evaluation pipeline (Phase 4)"
if ! python3 evaluation/evaluate.py; then
  echo
  echo "evaluate.py failed - most likely backend/models/*.onnx isn't exported yet"
  echo "(needs torch+torchvision and network access to the model weights host;"
  echo "see zk/README.md's Phase 4 section). Stopping here - this is a real"
  echo "prerequisite, not something to fake past."
  exit 1
fi

hr "STEP 4  Witness assembly (Phase 6 scaffolding)"
node witness/buildWitness.mjs --threshold "$THRESHOLD"

hr "STEP 5  Accuracy circuit (Phase 5)"
if [ -f "$CIRCUIT" ]; then
  echo "Found $CIRCUIT - running the real setup/prove/verify chain."
  echo "(not yet implemented in this script - wire it in the same shape as"
  echo " scripts/phase1_square.sh once the circuit's actual template/signal"
  echo " names are known)"
  exit 1
else
  cat <<'PENDING'
PENDING: circuits/accuracy.circom is not present in this checkout yet.

Everything up to and including witness assembly (Steps 1-4) is real and
verified: a real Merkle commitment, a real cryptographically-bound sample
selection, a real model run, and a real (validated) witness input for the
accuracy claim, all just built and written to build/.

What's missing is the actual Circom circuit that turns that witness into a
Groth16 proof - that piece is being built separately. Once
circuits/accuracy.circom exists, re-run this script; Step 5 will pick it up
without any changes needed to Steps 1-4.
PENDING
fi

hr "PHASE 6 SCAFFOLDING - STATUS"
echo "  Merkle commitment       : done   (build/commitment.json)"
echo "  Bound sample selection  : done   (build/selection.json)"
echo "  Evaluation               : done   (build/evaluation.json)"
echo "  Witness assembly         : done   (build/accuracy_input.json)"
echo "  Accuracy circuit         : PENDING (circuits/accuracy.circom not present)"
