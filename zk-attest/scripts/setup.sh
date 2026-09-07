#!/usr/bin/env bash
#
# ZK-Attest — clean clone to working prover.
#
# Idempotent: every slow step (npm install, circom download, the Powers-of-Tau
# ceremony, the circuit-specific Groth16 setup) is guarded by an existence
# check, so a second run skips straight to "already have it" and finishes in
# under a second. Safe to run on four different laptops, including a Mac.
# Idempotent also means correct, not just fast: STEP 3c detects a changed
# circuit source or a changed POT_POWER and clears the artifacts that would
# otherwise silently be reused for the wrong circuit/ceremony size.
#
set -uo pipefail   # not -e: we want to handle a failed circom test-run ourselves

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

CIRCOM_VERSION="v2.1.9"
BUILD="build"
# Bumped from 12 to 14 when custodian EdDSA attestation was added: that
# verifier's scalar multiplications took the circuit from 2,303 to 6,510
# non-linear constraints, and snarkjs's own sizing check rejects 2^12 (and
# even 2^13) for a circuit this size ("6510*2 > 2**N"). This is exactly the
# ceiling the original brief warned would be the first thing to break —
# flagging it here rather than bumping it silently, per that rule.
POT_POWER=14
PTAU_0="$BUILD/pot${POT_POWER}_0.ptau"
PTAU_1="$BUILD/pot${POT_POWER}_1.ptau"
PTAU_FINAL="$BUILD/pot${POT_POWER}_final.ptau"

hr() { echo; echo "=================================================================="; echo " $1"; echo "=================================================================="; }

mkdir -p "$BUILD"

# ----------------------------------------------------------------- npm deps --
hr "STEP 1  npm dependencies"
if [ -d node_modules ] && [ -d node_modules/circomlib ] && [ -d node_modules/snarkjs ]; then
  echo "node_modules already present — skipping npm install."
else
  npm install
fi
SNARKJS="node_modules/.bin/snarkjs"

# --------------------------------------------------------------- circom bin --
hr "STEP 2  circom compiler ($CIRCOM_VERSION)"

fetch_circom() {
  local asset="$1"
  echo "Downloading $asset ..."
  curl -sL -o circom "https://github.com/iden3/circom/releases/download/${CIRCOM_VERSION}/${asset}"
  chmod +x circom
}

build_circom_from_source() {
  echo "Building circom from source via cargo (this takes a few minutes) ..."
  local src_dir
  src_dir="$(mktemp -d)"
  git clone --depth 1 --branch v2.2.2 https://github.com/iden3/circom "$src_dir"
  cargo build --release --manifest-path "$src_dir/Cargo.toml" -p circom
  cp "$src_dir/target/release/circom" ./circom
  chmod +x ./circom
  rm -rf "$src_dir"
}

if [ -x ./circom ]; then
  echo "./circom already present — skipping download."
else
  OS="$(uname -s)"
  ARCH="$(uname -m)"

  case "$OS" in
    Linux)
      case "$ARCH" in
        x86_64) fetch_circom "circom-linux-amd64" ;;
        *)
          echo "No prebuilt circom binary for Linux/$ARCH — building from source."
          if ! command -v cargo >/dev/null 2>&1; then
            echo "ERROR: cargo (Rust) is required to build circom on this platform." >&2
            echo "       Install it from https://rustup.rs and re-run." >&2
            exit 1
          fi
          build_circom_from_source
          ;;
      esac
      ;;
    Darwin)
      fetch_circom "circom-macos-amd64"
      if ! ./circom --version >/dev/null 2>&1; then
        echo
        echo "circom-macos-amd64 did not run. On Apple Silicon this almost always"
        echo "means Rosetta 2 is missing. Fix with:"
        echo
        echo "    softwareupdate --install-rosetta --agree-to-license"
        echo
        if command -v cargo >/dev/null 2>&1; then
          echo "cargo is available — building circom from source instead so this"
          echo "doesn't block on Rosetta being installed."
          rm -f ./circom
          build_circom_from_source
        else
          echo "cargo is not available either. Install Rosetta (above) and re-run," >&2
          echo "or install Rust from https://rustup.rs as an alternative." >&2
          exit 1
        fi
      fi
      ;;
    *)
      echo "ERROR: unsupported platform $OS/$ARCH." >&2
      exit 1
      ;;
  esac
fi

echo "circom: $(./circom --version 2>&1 | head -1)"

# --------------------------------------------------------------- compile ----
hr "STEP 3  Compile circuits/settlement.circom"
# -l . lets circom resolve the circuit's own
# `include "node_modules/circomlib/circuits/...circom"` paths (relative to the
# repo root, where npm installed them) even though the including file lives in
# circuits/. This is a compiler flag, not a change to the frozen circuit.
COMPILE_LOG="$BUILD/compile.log"
./circom circuits/settlement.circom --r1cs --wasm --sym -l . -o "$BUILD" 2>&1 | tee "$COMPILE_LOG"
if [ ! -f "$BUILD/settlement.r1cs" ]; then
  echo "ERROR: compilation failed — see $COMPILE_LOG" >&2
  exit 1
fi

hr "STEP 3b  Record circuit stats (read from the compiler's own output, never hand-typed)"
# circom prints these lines itself right after compiling (see $COMPILE_LOG,
# written in STEP 3). Parsing that — not typing a constant — is what makes
# this number trustworthy if the circuit or the circomlib version ever changes.
NONLINEAR=$(grep -i "^non-linear constraints" "$COMPILE_LOG" | grep -oE '[0-9]+' | head -1)
LINEAR=$(grep -i "^linear constraints" "$COMPILE_LOG" | grep -oE '[0-9]+' | head -1)
PRIVATE_INPUTS=$(grep -i "^private inputs" "$COMPILE_LOG" | grep -oE '[0-9]+' | head -1)
PUBLIC_INPUTS=$(grep -i "^public inputs" "$COMPILE_LOG" | grep -oE '[0-9]+' | head -1)

cat > "$BUILD/circuit-stats.json" <<EOF
{
  "nonLinearConstraints": ${NONLINEAR:-null},
  "linearConstraints": ${LINEAR:-null},
  "privateInputs": ${PRIVATE_INPUTS:-null},
  "publicInputs": ${PUBLIC_INPUTS:-null},
  "source": "parsed from the circom compiler's own stdout at setup time",
  "generatedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
echo "Wrote $BUILD/circuit-stats.json:"
cat "$BUILD/circuit-stats.json"

# ------------------------------------------------ staleness invalidation ---
hr "STEP 3c  Invalidate stale artifacts if the circuit or ceremony size changed"
# The existence checks below (STEP 4/5) only ask "does this file exist?" —
# they don't ask "was it built from the circuit/ceremony-size that exists
# right now?". Editing circuits/settlement.circom and re-running this script
# used to silently keep the *previous* circuit's zkey, which snarkjs happily
# used to produce proofs that verify against the wrong verification key for
# the circuit you think you're running. This step catches both ways that can
# happen: the circuit source changing, or POT_POWER changing (which is
# exactly what happened when custodian attestation pushed constraints past
# the original 2^12 ceremony's capacity).
CIRCUIT_HASH_FILE="$BUILD/circuit.sha256"
POT_POWER_FILE="$BUILD/pot_power.txt"
CURRENT_CIRCUIT_HASH="$(sha256sum circuits/settlement.circom | awk '{print $1}')"

if [ -f "$CIRCUIT_HASH_FILE" ] && [ "$(cat "$CIRCUIT_HASH_FILE")" != "$CURRENT_CIRCUIT_HASH" ]; then
  echo "circuits/settlement.circom changed since the last build — clearing the zkey (it was built for the old circuit)."
  rm -f "$BUILD/s_0000.zkey" "$BUILD/settlement_final.zkey" "$BUILD/verification_key.json"
fi
echo "$CURRENT_CIRCUIT_HASH" > "$CIRCUIT_HASH_FILE"

if [ -f "$POT_POWER_FILE" ] && [ "$(cat "$POT_POWER_FILE")" != "$POT_POWER" ]; then
  echo "POT_POWER changed ($(cat "$POT_POWER_FILE") -> $POT_POWER) since the last ceremony — clearing the old ptau and zkey."
  rm -f "$BUILD"/pot*.ptau "$BUILD/s_0000.zkey" "$BUILD/settlement_final.zkey" "$BUILD/verification_key.json"
fi
echo "$POT_POWER" > "$POT_POWER_FILE"

# ------------------------------------------------------- powers of tau -----
hr "STEP 4  Powers-of-Tau ceremony (2^${POT_POWER} — local dev, NOT a trusted setup)"
if [ -f "$PTAU_FINAL" ]; then
  echo "$PTAU_FINAL already exists — skipping (this is the slow step)."
else
  "$SNARKJS" powersoftau new bn128 "$POT_POWER" "$PTAU_0" -v
  "$SNARKJS" powersoftau contribute "$PTAU_0" "$PTAU_1" \
    --name="zk-attest demo" -v \
    -e="$(head -c 64 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  "$SNARKJS" powersoftau prepare phase2 "$PTAU_1" "$PTAU_FINAL" -v
fi

# ------------------------------------------------------------ groth16 ------
hr "STEP 5  Groth16 setup + final zkey"
if [ -f "$BUILD/settlement_final.zkey" ]; then
  echo "$BUILD/settlement_final.zkey already exists — skipping."
else
  "$SNARKJS" groth16 setup "$BUILD/settlement.r1cs" "$PTAU_FINAL" "$BUILD/s_0000.zkey"
  "$SNARKJS" zkey contribute "$BUILD/s_0000.zkey" "$BUILD/settlement_final.zkey" \
    --name="zk-attest demo2" -v \
    -e="$(head -c 64 /dev/urandom | od -An -tx1 | tr -d ' \n')"
fi

if [ -f "$BUILD/verification_key.json" ]; then
  echo "$BUILD/verification_key.json already exists — skipping."
else
  "$SNARKJS" zkey export verificationkey "$BUILD/settlement_final.zkey" "$BUILD/verification_key.json"
fi

hr "DONE"
echo "build/settlement_final.zkey and build/verification_key.json are ready."
