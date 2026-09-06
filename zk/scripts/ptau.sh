#!/usr/bin/env bash
#
# Produces the Powers-of-Tau file that Groth16's setup phase needs.
#
# Groth16 needs a "phase 1" ceremony file that is independent of any circuit.
# Normally you download one produced by a large multi-party ceremony (e.g. the
# Hermez / Perpetual Powers of Tau files). That download is not reachable from
# this environment, so this script generates a small one locally instead.
#
# READ THE WARNING THIS SCRIPT PRINTS. The proofs are real Groth16 proofs, but
# a locally generated ceremony has no security against whoever generated it.
#
set -euo pipefail

ZK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ZK_DIR"

SNARKJS="node_modules/.bin/snarkjs"
BUILD_DIR="build"

# Circuit size: 2^12 = 4096 constraints. Plenty for phase 1 and phase 5.
POT_POWER="${POT_POWER:-12}"

# Single knob. Point this at a real ceremony file to swap out the dev one:
#   PTAU_FILE=/path/to/powersOfTau28_hez_final_12.ptau bash scripts/ptau.sh
PTAU_FILE="${PTAU_FILE:-$BUILD_DIR/pot${POT_POWER}_final.ptau}"

cat <<'WARNING'
+------------------------------------------------------------------+
|  WARNING: DEVELOPMENT CEREMONY - THIS IS NOT A TRUSTED SETUP.     |
|                                                                  |
|  This Powers-of-Tau file is generated locally by one machine      |
|  with one contribution. The "toxic waste" from that contribution  |
|  is not provably destroyed, so whoever runs this script COULD     |
|  forge proofs that verify.                                        |
|                                                                  |
|  The proofs themselves are genuine Groth16 proofs. The ceremony   |
|  behind them is not trustworthy. Do not use in production.        |
|  For real use, supply a multi-party ceremony file via PTAU_FILE.  |
+------------------------------------------------------------------+
WARNING
echo

mkdir -p "$BUILD_DIR"

if [ -f "$PTAU_FILE" ]; then
  echo "Powers of tau already present: $PTAU_FILE"
  echo "(delete it to regenerate)"
  exit 0
fi

echo "--- Step 1/3: new powers of tau (bn128, 2^$POT_POWER) ---"
$SNARKJS powersoftau new bn128 "$POT_POWER" "$BUILD_DIR/pot_0000.ptau" -v

echo "--- Step 2/3: contribute ---"
$SNARKJS powersoftau contribute "$BUILD_DIR/pot_0000.ptau" "$BUILD_DIR/pot_0001.ptau" \
  --name="ZK_MedTrust dev contribution" -v -e="$(head -c 64 /dev/urandom | od -An -tx1 | tr -d ' \n')"

echo "--- Step 3/3: prepare phase 2 ---"
$SNARKJS powersoftau prepare phase2 "$BUILD_DIR/pot_0001.ptau" "$PTAU_FILE" -v

rm -f "$BUILD_DIR/pot_0000.ptau" "$BUILD_DIR/pot_0001.ptau"

echo
echo "Done: $PTAU_FILE"
