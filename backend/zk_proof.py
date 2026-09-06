"""PHASE 7 - Python <-> Node bridge to the REAL ZK toolchain.

The ZK tooling (circom, snarkjs) lives under zk/ as Node/JS - that's where
Phases 1-6 built and verified it. Rather than reimplementing any of that in
Python, this module shells out to two small one-shot Node CLIs
(zk/witness/proveAccuracy.mjs, zk/witness/verifyAccuracy.mjs) that use
snarkjs's JS API directly - the same approach zk/test/accuracy.test.mjs
already uses and has verified working.

Nothing here performs or fakes cryptography itself. If the subprocess
call fails, this raises; if snarkjs says a proof doesn't verify, this
returns False. There is no code path that can produce a "verified" result
without the real snarkjs.groth16.verify() call agreeing.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
ZK_DIR = PROJECT_ROOT / "zk"
PROVE_SCRIPT = ZK_DIR / "witness" / "proveAccuracy.mjs"
VERIFY_SCRIPT = ZK_DIR / "witness" / "verifyAccuracy.mjs"

# Matches proveAccuracy.mjs / verifyAccuracy.mjs's documented exit codes.
_EXIT_CLAIM_NOT_PROVABLE = 2
_EXIT_TOOLCHAIN_NOT_READY = 3

_SUBPROCESS_TIMEOUT_SECONDS = 60


class ClaimNotProvableError(Exception):
    """The circuit's constraints refused this claim - there is no proof to
    generate, because none exists for a false statement. Expected, not a
    bug - see circuits/accuracy.circom's hard-constraint design."""


class ZkToolchainNotReadyError(Exception):
    """The compiled circuit / Groth16 setup artifacts aren't present yet.
    A real deployment runs that setup once, offline - see
    zk/scripts/phase5_accuracy.sh or zk/scripts/phase6_pipeline.sh."""


def _run_node_cli(script: Path, stdin_payload: dict) -> tuple[int, dict]:
    result = subprocess.run(
        ["node", str(script)],
        input=json.dumps(stdin_payload),
        capture_output=True,
        text=True,
        cwd=str(ZK_DIR),
        timeout=_SUBPROCESS_TIMEOUT_SECONDS,
    )
    try:
        parsed = json.loads(result.stdout.strip().splitlines()[-1]) if result.stdout.strip() else {}
    except (json.JSONDecodeError, IndexError):
        parsed = {}
    return result.returncode, parsed, result.stderr


def generate_accuracy_proof(correct: int, total: int, threshold: int) -> dict:
    """Generates a real Groth16 proof that correct/total meets threshold%,
    via circuits/accuracy.circom. Returns {"proof": {...}, "publicSignals": [...]}.

    Raises ClaimNotProvableError if the claim is false (or out of range) -
    this is the circuit correctly doing its job, not this function failing.
    Raises ZkToolchainNotReadyError if the one-time setup hasn't been run.
    Raises RuntimeError for anything else unexpected.
    """
    returncode, parsed, stderr = _run_node_cli(
        PROVE_SCRIPT, {"correct": correct, "total": total, "threshold": threshold}
    )

    if returncode == 0:
        return parsed
    if returncode == _EXIT_CLAIM_NOT_PROVABLE:
        raise ClaimNotProvableError(parsed.get("message", "claim not provable"))
    if returncode == _EXIT_TOOLCHAIN_NOT_READY:
        raise ZkToolchainNotReadyError(parsed.get("message", "ZK toolchain not set up"))
    raise RuntimeError(f"proveAccuracy.mjs failed unexpectedly (exit {returncode}): {stderr}")


def verify_accuracy_proof(proof: dict, public_signals: list) -> bool:
    """Verifies a Groth16 proof against the real verification key. Always
    returns a bool - a malformed or tampered proof returns False, it does
    not raise. Raises ZkToolchainNotReadyError only if the verification key
    itself hasn't been generated yet (nothing to check against at all)."""
    returncode, parsed, stderr = _run_node_cli(
        VERIFY_SCRIPT, {"proof": proof, "publicSignals": public_signals}
    )

    if returncode == _EXIT_TOOLCHAIN_NOT_READY:
        raise ZkToolchainNotReadyError(parsed.get("message", "ZK toolchain not set up"))
    if returncode != 0:
        raise RuntimeError(f"verifyAccuracy.mjs failed unexpectedly (exit {returncode}): {stderr}")
    return bool(parsed.get("zk_verified", False))


def zk_toolchain_ready() -> bool:
    """Cheap check: are the compiled circuit + Groth16 setup artifacts
    present? Lets callers return a clean 503 instead of discovering this
    mid-request."""
    return (
        (ZK_DIR / "build" / "accuracy_js" / "accuracy.wasm").exists()
        and (ZK_DIR / "build" / "accuracy_final.zkey").exists()
        and (ZK_DIR / "build" / "accuracy_verification_key.json").exists()
    )
