#!/usr/bin/env bash
#
# ZK-Attest — compliance circuit setup.
#
# Compiles circuits/compliance.circom and runs its Groth16 trusted setup.
# Reuses the settlement circuit's existing Powers-of-Tau ceremony
# (build/pot14_final.ptau, produced by scripts/setup.sh) rather than
# running a new one: compliance.circom compiles to ~6,439 non-linear
# constraints, comfortably under the 2^14 ceremony's capacity
# (2*6439 = 12878 < 16384), so a second ceremony would just be wasted
# time for no additional capacity actually needed.
#
# Run scripts/setup.sh FIRST if build/pot14_final.ptau doesn't exist yet.
#
# Idempotent, same as scripts/setup.sh: every slow step is guarded by an
# existence check.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

BUILD="build/compliance"
PTAU="build/pot14_final.ptau"

hr() { echo; echo "=================================================================="; echo " $1"; echo "=================================================================="; }

if [ ! -f "$PTAU" ]; then
  echo "ERROR: $PTAU not found. Run 'bash scripts/setup.sh' first (it produces the" >&2
  echo "       Powers-of-Tau ceremony this script reuses)." >&2
  exit 1
fi

if [ ! -x ./circom ]; then
  echo "ERROR: ./circom not found. Run 'bash scripts/setup.sh' first (it builds/downloads it)." >&2
  exit 1
fi

mkdir -p "$BUILD"
SNARKJS="node_modules/.bin/snarkjs"

hr "STEP 1  Compile circuits/compliance.circom"
COMPILE_LOG="$BUILD/compile.log"
./circom circuits/compliance.circom --r1cs --wasm --sym -l . -o "$BUILD" 2>&1 | tee "$COMPILE_LOG"
if [ ! -f "$BUILD/compliance.r1cs" ]; then
  echo "ERROR: compilation failed — see $COMPILE_LOG" >&2
  exit 1
fi

hr "STEP 2  Groth16 setup (reusing $PTAU)"
if [ -f "$BUILD/compliance_final.zkey" ]; then
  echo "$BUILD/compliance_final.zkey already exists — skipping."
else
  "$SNARKJS" groth16 setup "$BUILD/compliance.r1cs" "$PTAU" "$BUILD/compliance_0000.zkey"
  "$SNARKJS" zkey contribute "$BUILD/compliance_0000.zkey" "$BUILD/compliance_final.zkey" \
    --name="zk-attest compliance demo" -v \
    -e="$(head -c 64 /dev/urandom | od -An -tx1 | tr -d ' \n')"
fi

if [ -f "$BUILD/verification_key.json" ]; then
  echo "$BUILD/verification_key.json already exists — skipping."
else
  "$SNARKJS" zkey export verificationkey "$BUILD/compliance_final.zkey" "$BUILD/verification_key.json"
fi

hr "DONE"
echo "$BUILD/compliance_final.zkey and $BUILD/verification_key.json are ready."
echo "The compliance.db SQLite file is built automatically the first time the server boots"
echo "(from compliance/compliance_cases.sql) -- no separate step needed for that."
