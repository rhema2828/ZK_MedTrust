#!/usr/bin/env bash
#
# PHASE 1 - end-to-end Groth16 sanity run on the x*x=y circuit.
#
# Walks the full chain and then deliberately breaks it twice:
#
#   1. compile the circuit
#   2. generate the witness
#   3. Groth16 setup (phase 2, circuit-specific)
#   4. export the verification key
#   5. generate a real proof
#   6. verify it                        -> must PASS
#   7. tamper with the PUBLIC INPUT     -> must FAIL
#   8. tamper with the PROOF itself     -> must FAIL
#
# If a tampered case verifies, that is a hard error and this script exits 1.
#
set -euo pipefail

ZK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ZK_DIR"

SNARKJS="node_modules/.bin/snarkjs"
BUILD="build"
POT_POWER="${POT_POWER:-12}"
PTAU_FILE="${PTAU_FILE:-$BUILD/pot${POT_POWER}_final.ptau}"

# The secret the prover knows, and the public value derived from it.
SECRET_X=7
PUBLIC_Y=49

hr() { echo; echo "=============================================================="; echo " $1"; echo "=============================================================="; }

if [ ! -f "$PTAU_FILE" ]; then
  echo "ERROR: missing $PTAU_FILE - run 'bash scripts/ptau.sh' first." >&2
  exit 1
fi

mkdir -p "$BUILD"

hr "STEP 1  Compile circuits/square.circom"
circom circuits/square.circom --r1cs --wasm --sym -o "$BUILD"
$SNARKJS r1cs info "$BUILD/square.r1cs"

hr "STEP 2  Generate the witness  (prover knows x=$SECRET_X)"
echo "{\"x\": $SECRET_X, \"y\": $PUBLIC_Y}" > "$BUILD/input.json"
cat "$BUILD/input.json"
node "$BUILD/square_js/generate_witness.js" \
     "$BUILD/square_js/square.wasm" \
     "$BUILD/input.json" \
     "$BUILD/witness.wtns"
echo "witness.wtns written"

hr "STEP 3  Groth16 setup (circuit-specific phase 2)"
$SNARKJS groth16 setup "$BUILD/square.r1cs" "$PTAU_FILE" "$BUILD/square_0000.zkey"
$SNARKJS zkey contribute "$BUILD/square_0000.zkey" "$BUILD/square_final.zkey" \
  --name="ZK_MedTrust phase1" -v \
  -e="$(head -c 64 /dev/urandom | od -An -tx1 | tr -d ' \n')"

hr "STEP 4  Export the verification key"
$SNARKJS zkey export verificationkey "$BUILD/square_final.zkey" "$BUILD/verification_key.json"
echo "verification_key.json written"

hr "STEP 5  Generate the proof"
$SNARKJS groth16 prove "$BUILD/square_final.zkey" "$BUILD/witness.wtns" \
  "$BUILD/proof.json" "$BUILD/public.json"
echo "--- proof.json ---"
cat "$BUILD/proof.json"
echo "--- public.json (this is ALL the verifier sees) ---"
cat "$BUILD/public.json"

hr "STEP 6  Verify the honest proof   (expect: OK)"
if $SNARKJS groth16 verify "$BUILD/verification_key.json" "$BUILD/public.json" "$BUILD/proof.json"; then
  echo ">>> PASS: valid proof verified."
else
  echo ">>> FAIL: a valid proof did not verify. Toolchain is broken." >&2
  exit 1
fi

hr "STEP 7  NEGATIVE TEST A - tamper with the public input"
echo "Claiming y=50 instead of y=$PUBLIC_Y, reusing the same proof."
sed "s/\"$PUBLIC_Y\"/\"50\"/" "$BUILD/public.json" > "$BUILD/public_tampered.json"
cat "$BUILD/public_tampered.json"
if $SNARKJS groth16 verify "$BUILD/verification_key.json" "$BUILD/public_tampered.json" "$BUILD/proof.json"; then
  echo ">>> FAIL: a tampered public input verified. This is a security failure." >&2
  exit 1
else
  echo ">>> PASS: tampered public input was rejected."
fi

hr "STEP 8  NEGATIVE TEST B - tamper with the proof itself"
echo "Corrupting the first field element of pi_a."
node -e '
  const fs = require("fs");
  const p = JSON.parse(fs.readFileSync("build/proof.json", "utf8"));
  // Flip the proof point to something that is not the honest one.
  p.pi_a[0] = (BigInt(p.pi_a[0]) + 1n).toString();
  fs.writeFileSync("build/proof_tampered.json", JSON.stringify(p, null, 1));
'
if $SNARKJS groth16 verify "$BUILD/verification_key.json" "$BUILD/public.json" "$BUILD/proof_tampered.json"; then
  echo ">>> FAIL: a tampered proof verified. This is a security failure." >&2
  exit 1
else
  echo ">>> PASS: tampered proof was rejected."
fi

hr "PHASE 1 COMPLETE"
cat <<'SUMMARY'
  valid proof              -> verified      PASS
  tampered public input    -> rejected      PASS
  tampered proof           -> rejected      PASS

The toolchain produces real Groth16 proofs and really rejects bad ones.
Reminder: the underlying Powers-of-Tau ceremony is a local DEVELOPMENT
ceremony, not a trusted setup. See README.md.
SUMMARY
