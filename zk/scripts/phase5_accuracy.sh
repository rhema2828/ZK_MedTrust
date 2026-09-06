#!/usr/bin/env bash
#
# PHASE 5 - end-to-end Groth16 sanity run on the accuracy threshold circuit.
#
# The circuit proves "correct_predictions * 100 >= threshold * total_predictions"
# (see circuits/accuracy.circom for the full public/private input rationale).
#
# Unlike Phase 1's square circuit, most of the interesting failure modes here
# are HARD CONSTRAINTS the circuit itself enforces (0 < total, correct <=
# total, threshold <= 100, accuracy >= threshold). A witness that violates
# one of these cannot be computed at all -- there is no "generate a witness,
# then check if it's valid" step, because the constraint system has no
# satisfying assignment. So most negative cases here are asserted to fail at
# WITNESS GENERATION, which is a stronger guarantee than Phase 1's
# after-the-fact proof tampering (nothing can ever be proven for these
# inputs, not just "a wrong proof gets rejected").
#
# One after-the-fact tamper test is still included for parity with Phase 1:
# take a genuinely valid proof and swap its public inputs post-hoc.
#
set -uo pipefail   # NOT -e: this script expects several commands to fail on purpose

ZK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ZK_DIR"

SNARKJS="node_modules/.bin/snarkjs"
BUILD="build"
POT_POWER="${POT_POWER:-12}"
PTAU_FILE="${PTAU_FILE:-$BUILD/pot${POT_POWER}_final.ptau}"

hr() { echo; echo "=============================================================="; echo " $1"; echo "=============================================================="; }

if [ ! -f "$PTAU_FILE" ]; then
  echo "ERROR: missing $PTAU_FILE - run 'bash scripts/ptau.sh' first." >&2
  exit 1
fi

mkdir -p "$BUILD"

hr "STEP 1  Compile circuits/accuracy.circom"
circom circuits/accuracy.circom --r1cs --wasm --sym -o "$BUILD"
$SNARKJS r1cs info "$BUILD/accuracy.r1cs"

hr "STEP 2  Groth16 setup (circuit-specific phase 2, reusing $PTAU_FILE)"
$SNARKJS groth16 setup "$BUILD/accuracy.r1cs" "$PTAU_FILE" "$BUILD/accuracy_0000.zkey"
$SNARKJS zkey contribute "$BUILD/accuracy_0000.zkey" "$BUILD/accuracy_final.zkey" \
  --name="ZK_MedTrust phase5" -v \
  -e="$(head -c 64 /dev/urandom | od -An -tx1 | tr -d ' \n')"
$SNARKJS zkey export verificationkey "$BUILD/accuracy_final.zkey" "$BUILD/accuracy_verification_key.json"

# args: name, correct, total, threshold
make_input() {
  echo "{\"correct_predictions\": $2, \"total_predictions\": $3, \"threshold\": $4}" > "$BUILD/accuracy_input_$1.json"
}

FAILURES=0

# Attempts witness generation for a case that MUST be constraint-unsatisfiable.
# Passing (i.e. a witness gets produced) is the failure here.
expect_witness_generation_fails() {
  local name="$1"
  if node "$BUILD/accuracy_js/generate_witness.js" \
       "$BUILD/accuracy_js/accuracy.wasm" \
       "$BUILD/accuracy_input_$name.json" \
       "$BUILD/accuracy_witness_$name.wtns" >/tmp/accuracy_${name}.log 2>&1; then
    echo ">>> FAIL: witness generation for '$name' SUCCEEDED but should have violated a constraint." >&2
    FAILURES=$((FAILURES+1))
  else
    echo ">>> PASS: witness generation for '$name' correctly failed (constraint violated)."
  fi
}

hr "STEP 3  Positive case: correct=90, total=100, threshold=85  (90% >= 85%)"
make_input valid 90 100 85
node "$BUILD/accuracy_js/generate_witness.js" \
     "$BUILD/accuracy_js/accuracy.wasm" \
     "$BUILD/accuracy_input_valid.json" \
     "$BUILD/accuracy_witness_valid.wtns"
echo "witness generated"

$SNARKJS groth16 prove "$BUILD/accuracy_final.zkey" "$BUILD/accuracy_witness_valid.wtns" \
  "$BUILD/accuracy_proof.json" "$BUILD/accuracy_public.json"
echo "--- accuracy_public.json (all the verifier sees: total_predictions, threshold) ---"
cat "$BUILD/accuracy_public.json"
echo

if $SNARKJS groth16 verify "$BUILD/accuracy_verification_key.json" "$BUILD/accuracy_public.json" "$BUILD/accuracy_proof.json"; then
  echo ">>> PASS: valid accuracy proof verified."
else
  echo ">>> FAIL: a valid proof did not verify. Toolchain is broken." >&2
  FAILURES=$((FAILURES+1))
fi

hr "STEP 4  Negative: accuracy below threshold (correct=80,total=100,threshold=85 -> 80%<85%)"
make_input below_threshold 80 100 85
expect_witness_generation_fails below_threshold

hr "STEP 5  Negative: correct_predictions > total_predictions (110 > 100)"
make_input correct_gt_total 110 100 85
expect_witness_generation_fails correct_gt_total

hr "STEP 6  Negative: total_predictions = 0"
make_input zero_total 0 0 85
expect_witness_generation_fails zero_total

hr "STEP 7  Negative: invalid threshold (150, > SCALE of 100)"
make_input bad_threshold 90 100 150
expect_witness_generation_fails bad_threshold

hr "STEP 8  Negative (after-the-fact, parity with Phase 1): tamper with public inputs post-hoc"
echo "Reusing the valid proof from Step 3, but claiming threshold=10 instead of 85."
sed 's/"85"/"10"/' "$BUILD/accuracy_public.json" > "$BUILD/accuracy_public_tampered.json"
cat "$BUILD/accuracy_public_tampered.json"
if $SNARKJS groth16 verify "$BUILD/accuracy_verification_key.json" "$BUILD/accuracy_public_tampered.json" "$BUILD/accuracy_proof.json"; then
  echo ">>> FAIL: a proof verified against public inputs it wasn't generated for. Security failure." >&2
  FAILURES=$((FAILURES+1))
else
  echo ">>> PASS: proof correctly rejected against tampered public inputs."
fi

hr "PHASE 5 SUMMARY"
if [ "$FAILURES" -eq 0 ]; then
  cat <<'SUMMARY'
  valid claim (90% >= 85%)         -> proof verified         PASS
  accuracy below threshold         -> no witness exists       PASS
  correct > total                  -> no witness exists       PASS
  total_predictions = 0            -> no witness exists       PASS
  invalid threshold (>100)         -> no witness exists       PASS
  tampered public inputs           -> rejected                PASS

The circuit enforces its constraints for real: false accuracy claims are not
just "wrong proofs that get rejected" -- they are statements with no valid
witness at all. Reminder: the underlying Powers-of-Tau ceremony is a local
DEVELOPMENT ceremony, not a trusted setup. See README.md.
SUMMARY
  exit 0
else
  echo "$FAILURES check(s) FAILED - see above." >&2
  exit 1
fi
