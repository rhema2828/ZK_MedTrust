#!/usr/bin/env bash
#
# PHASE 6 - the full chain, for real:
#
#   dataset -> Merkle root -> bound sample selection -> evaluation
#            -> witness assembly -> accuracy circuit -> Groth16 proof -> verify
#
# Unlike scripts/phase5_accuracy.sh (which proves hand-typed example numbers
# to demonstrate the circuit works at all), this script proves whatever
# correct_predictions/total_predictions the REAL evaluation pipeline
# actually produced - Phase 6's job is exactly that connection, not a new
# circuit.
#
# IMPORTANT: if the real evaluation result does NOT meet the claimed
# threshold, the circuit's constraints mean witness generation itself
# fails - there is no "generate a witness, then get an invalid proof" step
# for this circuit (see circuits/accuracy.circom). That is not a bug in
# this script: it is the same hard-constraint guarantee Phase 5 already
# demonstrates with hand-typed numbers, now demonstrated against a REAL
# evaluation run. This script checks which case it's in first and reports
# either outcome as a PASS.
#
set -uo pipefail   # NOT -e: several commands below are expected to fail on purpose

ZK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ZK_DIR"

SNARKJS="node_modules/.bin/snarkjs"
BUILD="build"
POT_POWER="${POT_POWER:-12}"
PTAU_FILE="${PTAU_FILE:-$BUILD/pot${POT_POWER}_final.ptau}"
DATASET="${DATASET:-data/sample_dataset.json}"
SAMPLE_SIZE="${SAMPLE_SIZE:-3}"
THRESHOLD="${THRESHOLD:-50}"

hr() { echo; echo "=============================================================="; echo " $1"; echo "=============================================================="; }

if [ ! -f "$PTAU_FILE" ]; then
  echo "ERROR: missing $PTAU_FILE - run 'bash scripts/ptau.sh' first." >&2
  exit 1
fi

hr "STEP 1  Merkle commitment (Phase 2)"
node merkle/commitDataset.mjs "$DATASET"

hr "STEP 2  Bound sample selection (Phase 3)"
node sampling/selectFromCommitment.mjs "$SAMPLE_SIZE"

hr "STEP 3  Evaluation pipeline (Phase 4) - runs the real model"
if ! python3 evaluation/evaluate.py; then
  cat >&2 <<'BLOCKED'

evaluate.py failed. Most likely backend/models/densenet121_xrv.onnx isn't
exported yet, which needs torchxrayvision installed (`pip install
torchxrayvision`) and network access to download its pretrained weights.
This is a real prerequisite, not a code bug - see CLAUDE.md / zk/README.md.
Not faking past it.
BLOCKED
  exit 1
fi

hr "STEP 4  Witness assembly (Phase 6)"
WITNESS_LOG="$BUILD/witness_assembly.log"
node witness/buildWitness.mjs --threshold "$THRESHOLD" | tee "$WITNESS_LOG"
if grep -q "does NOT satisfy" "$WITNESS_LOG"; then
  CLAIM_MET=false
else
  CLAIM_MET=true
fi

hr "STEP 5  Compile circuits/accuracy.circom (Phase 5, reused as-is)"
circom circuits/accuracy.circom --r1cs --wasm --sym -o "$BUILD"
$SNARKJS r1cs info "$BUILD/accuracy.r1cs"

hr "STEP 6  Groth16 setup (reusing $PTAU_FILE)"
$SNARKJS groth16 setup "$BUILD/accuracy.r1cs" "$PTAU_FILE" "$BUILD/accuracy_0000.zkey"
$SNARKJS zkey contribute "$BUILD/accuracy_0000.zkey" "$BUILD/accuracy_final.zkey" \
  --name="ZK_MedTrust phase6" -v \
  -e="$(head -c 64 /dev/urandom | od -An -tx1 | tr -d ' \n')"
$SNARKJS zkey export verificationkey "$BUILD/accuracy_final.zkey" "$BUILD/accuracy_verification_key.json"

hr "STEP 7  Generate witness from the REAL evaluation result"
if [ "$CLAIM_MET" = false ]; then
  echo "The real evaluation result does not meet threshold=$THRESHOLD%."
  echo "Expecting witness generation to FAIL - that failure is the circuit"
  echo "correctly refusing to let a false claim be proven."
  if node "$BUILD/accuracy_js/generate_witness.js" \
       "$BUILD/accuracy_js/accuracy.wasm" \
       "$BUILD/accuracy_input.json" \
       "$BUILD/accuracy_witness.wtns" 2>"$BUILD/witness_gen.log"; then
    echo ">>> FAIL: witness generation SUCCEEDED for a claim that should have violated a constraint." >&2
    exit 1
  else
    echo ">>> PASS: witness generation correctly failed - no proof can be produced for this false claim."
    grep -q "Assert Failed" "$BUILD/witness_gen.log" && echo "    (circuit assertion failed, as expected: $(grep -o 'AccuracyThreshold_[0-9]* line: [0-9]*' "$BUILD/witness_gen.log" | head -1))"
  fi

  hr "PHASE 6 COMPLETE - claim correctly rejected"
  cat <<SUMMARY
The real evaluation pipeline's result did not clear the $THRESHOLD% threshold,
and the circuit correctly refused to produce a witness for it at all - not
just an invalid proof, no proof is possible. To see the positive path (a
proof that actually verifies), re-run with a threshold your last evaluation
run's real accuracy clears, e.g.:
    THRESHOLD=<lower number> bash scripts/phase6_pipeline.sh
SUMMARY
  exit 0
fi

echo "The real evaluation result meets threshold=$THRESHOLD% - generating a witness normally."
node "$BUILD/accuracy_js/generate_witness.js" \
     "$BUILD/accuracy_js/accuracy.wasm" \
     "$BUILD/accuracy_input.json" \
     "$BUILD/accuracy_witness.wtns"

hr "STEP 8  Prove and verify"
$SNARKJS groth16 prove "$BUILD/accuracy_final.zkey" "$BUILD/accuracy_witness.wtns" \
  "$BUILD/accuracy_proof.json" "$BUILD/accuracy_public.json"
echo "--- accuracy_public.json (all the verifier sees: total_predictions, threshold) ---"
cat "$BUILD/accuracy_public.json"
echo

if $SNARKJS groth16 verify "$BUILD/accuracy_verification_key.json" "$BUILD/accuracy_public.json" "$BUILD/accuracy_proof.json"; then
  echo ">>> PASS: the real evaluation pipeline's accuracy claim verified."
else
  echo ">>> FAIL: a witness existed but the proof did not verify - toolchain is broken." >&2
  exit 1
fi

hr "PHASE 6 COMPLETE"
cat <<'SUMMARY'
Merkle commitment -> bound sample selection -> real model evaluation ->
witness assembly -> accuracy circuit -> Groth16 proof -> verification, all
run end to end against real evaluation output, not hand-typed numbers.

What's ZK-enforced vs protocol-enforced (see zk/README.md for the full
table): the accuracy inequality itself is enforced by the circuit (a real
Groth16 guarantee). Image integrity, Merkle inclusion, and deterministic
sampling are enforced by ordinary, independently-auditable code - real,
but not a ZK-SNARK guarantee.

Reminder: the underlying Powers-of-Tau ceremony is a local DEVELOPMENT
ceremony, not a trusted setup. See README.md.
SUMMARY
