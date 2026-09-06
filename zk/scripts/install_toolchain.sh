#!/usr/bin/env bash
#
# Installs the two tools the ZK layer needs:
#
#   circom   - the circuit compiler   (Rust binary, built from source)
#   snarkjs  - the Groth16 prover/verifier (npm package, installed locally)
#
# Safe to re-run: anything already present is skipped.
#
set -euo pipefail

ZK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CIRCOM_VERSION="v2.2.2"
CIRCOM_SRC_DIR="${CIRCOM_SRC_DIR:-$HOME/.cache/circom-src}"

echo "=============================================="
echo " ZK_MedTrust - toolchain install"
echo "=============================================="

# ---------------------------------------------------------------- circom ----
if command -v circom >/dev/null 2>&1; then
  echo "[circom]  already installed: $(circom --version)"
else
  echo "[circom]  not found - building $CIRCOM_VERSION from source."
  echo "[circom]  (circom is not published to npm or crates.io; building is the"
  echo "[circom]   documented install path. This takes a few minutes.)"

  if ! command -v cargo >/dev/null 2>&1; then
    echo "ERROR: cargo (Rust) is required to build circom but was not found." >&2
    echo "       Install Rust from https://rustup.rs and re-run this script." >&2
    exit 1
  fi

  if [ ! -d "$CIRCOM_SRC_DIR/.git" ]; then
    mkdir -p "$(dirname "$CIRCOM_SRC_DIR")"
    git clone --depth 1 --branch "$CIRCOM_VERSION" \
      https://github.com/iden3/circom "$CIRCOM_SRC_DIR"
  fi

  cargo install --path "$CIRCOM_SRC_DIR/circom" --locked

  if ! command -v circom >/dev/null 2>&1; then
    echo "ERROR: circom built but is not on PATH." >&2
    echo "       Add \$HOME/.cargo/bin to your PATH and re-run." >&2
    exit 1
  fi
  echo "[circom]  installed: $(circom --version)"
fi

# --------------------------------------------------------------- snarkjs ----
cd "$ZK_DIR"
if [ -x "node_modules/.bin/snarkjs" ]; then
  echo "[snarkjs] already installed."
else
  echo "[snarkjs] installing via npm..."
  if [ -f package-lock.json ]; then npm ci; else npm install; fi
fi

# --------------------------------------------------------------- report -----
echo
echo "----------------------------------------------"
echo " Resolved toolchain"
echo "----------------------------------------------"
echo "circom  : $(command -v circom)"
echo "          $(circom --version)"
echo "snarkjs : $ZK_DIR/node_modules/.bin/snarkjs"
echo "          $(node_modules/.bin/snarkjs --version 2>&1 | head -1)"
echo "node    : $(node --version)"
echo
echo "Toolchain ready."
