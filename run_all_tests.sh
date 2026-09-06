#!/usr/bin/env bash
#
# PHASE 9 - full test matrix, one command.
#
# Runs every test suite in the project (JS + Python) and prints one final
# summary. See zk/PHASE9_TEST_MATRIX.md for what each suite actually
# covers, mapped against the project brief's own checklist.
#
# Prerequisites (one-time, not run by this script):
#   cd zk && bash scripts/install_toolchain.sh && bash scripts/ptau.sh
#   bash zk/scripts/phase1_square.sh
#   bash zk/scripts/phase5_accuracy.sh
# Without these, the tests that need compiled circuit artifacts skip
# themselves (documented, not a silent failure) rather than error.
#
set -uo pipefail   # NOT -e: we want every suite to run even if one fails

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

hr() { echo; echo "=============================================================="; echo " $1"; echo "=============================================================="; }

FAILED_SUITES=()

hr "JS test suite (zk/)"
if (cd zk && npm test); then
  echo ">>> zk/ JS suite: PASS"
else
  echo ">>> zk/ JS suite: FAIL" >&2
  FAILED_SUITES+=("zk (JS)")
fi

hr "Python: backend/test_security.py"
if python3 -m unittest backend.test_security -v; then
  echo ">>> backend/test_security.py: PASS"
else
  echo ">>> backend/test_security.py: FAIL" >&2
  FAILED_SUITES+=("backend/test_security.py")
fi

hr "Python: backend/test_zk_proof.py"
if python3 -m unittest backend.test_zk_proof -v; then
  echo ">>> backend/test_zk_proof.py: PASS"
else
  echo ">>> backend/test_zk_proof.py: FAIL" >&2
  FAILED_SUITES+=("backend/test_zk_proof.py")
fi

hr "Python: zk/evaluation/test_evaluate.py"
if python3 -m unittest zk.evaluation.test_evaluate -v; then
  echo ">>> zk/evaluation/test_evaluate.py: PASS"
else
  echo ">>> zk/evaluation/test_evaluate.py: FAIL" >&2
  FAILED_SUITES+=("zk/evaluation/test_evaluate.py")
fi

hr "SUMMARY"
if [ ${#FAILED_SUITES[@]} -eq 0 ]; then
  echo "All suites passed. See zk/PHASE9_TEST_MATRIX.md for what's covered."
  exit 0
else
  echo "FAILED suites:" >&2
  for suite in "${FAILED_SUITES[@]}"; do
    echo "  - $suite" >&2
  done
  exit 1
fi
