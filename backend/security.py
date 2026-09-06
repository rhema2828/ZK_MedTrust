"""PHASE 8 - security layer for the ZK endpoints.

Scoped deliberately narrow: these utilities protect `/generate_proof` (and,
once it exists, `/verify_proof`) - not `/predict`, which already handles its
own temp file correctly and isn't part of the ZK proof surface this phase
is guarding.

IMPORTANT - the separation this whole module exists to preserve:

    API security (this file)
          v
    request authentication / anti-replay
          v
    ZK proof generation
          v
    Groth16 proof
          v
    Groth16 verification

Nothing here is a substitute for the Groth16 proof/verification itself.
An API key proves "this caller is allowed to ask for a proof." It does not
prove anything about model accuracy, and it must never be treated as if it
did. Likewise, `validate_proof_request`'s range checks and
`buildAccuracyWitness`'s matching checks in zk/witness/witnessBuilder.mjs
are fail-fast guardrails for the honest path, not a cryptographic
guarantee - a party who controls their own request never has to go through
this code at all. The circuit (once it exists, Phase 5/7) is the actual
trust boundary for the accuracy claim; everything in this file is ordinary
application-layer hygiene around it.

This module is demo/hackathon-scale on purpose, and says so at each spot
where a real production deployment would need more (see individual
docstrings): in-memory rate limiting and nonce tracking (single process,
resets on restart - a real deployment would use Redis or similar), and a
single static API key from an environment variable (a real deployment
would use per-client keys with rotation/revocation).
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import tempfile
import threading
import time
import uuid
from contextlib import contextmanager
from pathlib import Path

from fastapi import Header, HTTPException

# ---------------------------------------------------------------- API key ---

API_KEY_ENV_VAR = "ZK_API_KEY"


def require_api_key(x_api_key: str | None = Header(default=None)) -> str:
    """FastAPI dependency: reject the request unless X-API-Key matches
    ZK_API_KEY. Fails CLOSED: if ZK_API_KEY isn't configured at all, this
    raises rather than silently letting every request through - "no key
    configured" must never mean "no auth required."
    """
    configured_key = os.environ.get(API_KEY_ENV_VAR)
    if not configured_key:
        raise HTTPException(
            status_code=500,
            detail=(
                f"Server misconfigured: {API_KEY_ENV_VAR} is not set. "
                "This endpoint refuses to run without an API key configured "
                "(see zk/README.md's Phase 8 section) - it does not fall "
                "back to allowing unauthenticated requests."
            ),
        )
    if not x_api_key or not hmac.compare_digest(x_api_key, configured_key):
        raise HTTPException(status_code=401, detail="Missing or invalid X-API-Key.")
    return x_api_key


# ----------------------------------------------------------- rate limiting --


class RateLimiter:
    """Fixed-window rate limiter, keyed by an arbitrary string (an API key,
    typically). In-memory and per-process only - fine for a single-process
    demo deployment; a real multi-process deployment needs a shared store
    (Redis, etc.) or requests can slip through on whichever process
    happens to serve them.
    """

    def __init__(self, max_requests: int, window_seconds: float):
        if max_requests <= 0:
            raise ValueError("max_requests must be > 0")
        if window_seconds <= 0:
            raise ValueError("window_seconds must be > 0")
        self.max_requests = max_requests
        self.window_seconds = window_seconds
        self._lock = threading.Lock()
        # key -> (window_start_timestamp, count_in_window)
        self._windows: dict[str, tuple[float, int]] = {}

    def allow(self, key: str, *, now: float | None = None) -> bool:
        now = time.time() if now is None else now
        with self._lock:
            window_start, count = self._windows.get(key, (now, 0))
            if now - window_start >= self.window_seconds:
                # window has rolled over - start a fresh one
                window_start, count = now, 0
            if count >= self.max_requests:
                self._windows[key] = (window_start, count)
                return False
            self._windows[key] = (window_start, count + 1)
            return True

    def reset(self) -> None:
        """Test helper - clears all tracked windows."""
        with self._lock:
            self._windows.clear()


# Shared instance used by the FastAPI dependency below. Demo-scale default:
# 10 requests per 60 seconds per API key.
_default_rate_limiter = RateLimiter(max_requests=10, window_seconds=60)


def enforce_rate_limit(api_key: str = Header(default="anonymous", alias="X-API-Key")) -> None:
    """FastAPI dependency. Must run after require_api_key in practice (so a
    caller can't burn an unauthenticated party's rate-limit bucket), but is
    keyed defensively on the header value either way.
    """
    if not _default_rate_limiter.allow(api_key):
        raise HTTPException(
            status_code=429,
            detail=(
                f"Rate limit exceeded: max {_default_rate_limiter.max_requests} "
                f"requests per {_default_rate_limiter.window_seconds:.0f}s."
            ),
        )


# -------------------------------------------------------- input validation --

ACCURACY_SCALE = 100  # matches zk/witness/witnessBuilder.mjs's SCALE


def validate_proof_request(claimed_accuracy: int, correct: int, total: int) -> None:
    """Range checks beyond what Pydantic's type validation already covers.

    Deliberately the same three checks the (pending) accuracy circuit will
    also enforce for real - see this module's docstring for why duplicating
    them here is a fail-fast convenience, not a security boundary.
    """
    if total <= 0:
        raise HTTPException(status_code=400, detail="total must be > 0.")
    if correct < 0 or correct > total:
        raise HTTPException(
            status_code=400,
            detail=f"correct must satisfy 0 <= correct <= total (correct={correct}, total={total}).",
        )
    if claimed_accuracy < 0 or claimed_accuracy > ACCURACY_SCALE:
        raise HTTPException(
            status_code=400,
            detail=f"claimed_accuracy must satisfy 0 <= claimed_accuracy <= {ACCURACY_SCALE}.",
        )


# ------------------------------------------------------------ HMAC tickets --

_TICKET_SECRET_ENV_VAR = "ZK_TICKET_SECRET"


def _ticket_secret() -> bytes:
    secret = os.environ.get(_TICKET_SECRET_ENV_VAR)
    if not secret:
        raise RuntimeError(
            f"{_TICKET_SECRET_ENV_VAR} is not set - tickets cannot be issued or "
            "verified without a signing secret. See zk/README.md's Phase 8 section."
        )
    return secret.encode("utf-8")


class TicketError(Exception):
    """Raised by verify_ticket for any invalid/expired/replayed/tampered ticket."""


# In-memory nonce store for replay protection: nonce -> expiry timestamp.
# Demo-scale (single process, unbounded until _prune_seen_nonces runs) - a
# real deployment needs a shared, TTL-expiring store (Redis SETEX etc).
_seen_nonces: dict[str, float] = {}
_seen_nonces_lock = threading.Lock()


def _prune_seen_nonces(now: float) -> None:
    expired = [n for n, exp in _seen_nonces.items() if exp <= now]
    for n in expired:
        del _seen_nonces[n]


def issue_ticket(payload: dict, ttl_seconds: float) -> str:
    """Issues an HMAC-SHA256-signed ticket binding a nonce + expiry to a
    HASH of `payload` - never the payload itself. This is what keeps
    patient data (or anything else sensitive) out of the ticket: the
    ticket proves "this exact request was authorized at this exact time,"
    without the ticket itself carrying the request's content.
    """
    now = time.time()
    nonce = secrets.token_hex(16)
    payload_hash = hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()

    body = {
        "nonce": nonce,
        "issued_at": now,
        "expires_at": now + ttl_seconds,
        "payload_hash": payload_hash,
    }
    body_json = json.dumps(body, sort_keys=True, separators=(",", ":"))
    signature = hmac.new(_ticket_secret(), body_json.encode("utf-8"), hashlib.sha256).hexdigest()

    envelope = {"body": body, "signature": signature}
    return json.dumps(envelope, separators=(",", ":"))


def verify_ticket(ticket: str, payload: dict) -> dict:
    """Verifies a ticket's signature, expiry, payload hash, and (via the
    in-memory nonce store) that it hasn't already been used. Raises
    TicketError on any failure; returns the ticket's body dict on success.

    Checking the nonce is what makes this "anti-replay": a second
    verify_ticket() call with the exact same ticket fails even though the
    signature and expiry are still individually valid.
    """
    try:
        envelope = json.loads(ticket)
        body = envelope["body"]
        signature = envelope["signature"]
        nonce = body["nonce"]
        expires_at = body["expires_at"]
        payload_hash = body["payload_hash"]
    except (json.JSONDecodeError, KeyError, TypeError) as exc:
        raise TicketError(f"Malformed ticket: {exc}") from exc

    body_json = json.dumps(body, sort_keys=True, separators=(",", ":"))
    expected_signature = hmac.new(_ticket_secret(), body_json.encode("utf-8"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(signature, expected_signature):
        raise TicketError("Ticket signature does not match - tampered or forged.")

    now = time.time()
    if now > expires_at:
        raise TicketError("Ticket has expired.")

    actual_payload_hash = hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    if not hmac.compare_digest(payload_hash, actual_payload_hash):
        raise TicketError("Ticket does not match the supplied payload.")

    with _seen_nonces_lock:
        _prune_seen_nonces(now)
        if nonce in _seen_nonces:
            raise TicketError("Ticket has already been used (replay detected).")
        _seen_nonces[nonce] = expires_at

    return body


# ------------------------------------------------------------ temp files ----


@contextmanager
def secure_tempfile(suffix: str = ""):
    """Context manager yielding a Path to a freshly created temp file with
    0600 permissions, guaranteed to be deleted on exit - including when the
    body of the `with` block raises. Not used by /predict (which already
    creates and cleans up its own temp file correctly) - this is for
    Phase 7's future witness/proof files, which don't exist yet.
    """
    fd, raw_path = tempfile.mkstemp(suffix=suffix)
    path = Path(raw_path)
    try:
        os.chmod(path, 0o600)
        os.close(fd)
        yield path
    finally:
        if path.exists():
            path.unlink()


# --------------------------------------------------------- model integrity --


def compute_model_sha256(model_path: Path) -> str:
    return hashlib.sha256(model_path.read_bytes()).hexdigest()


def verify_model_integrity(model_path: Path, expected_sha256: str | None = None) -> str:
    """Computes a model file's SHA-256. If expected_sha256 is given and
    doesn't match, raises - catching a swapped/tampered model file before
    it's used for inference. If expected_sha256 is None, just returns the
    computed hash (so an operator can pin it for next time). Standalone
    utility - not wired into ml_inference.py, which this project doesn't
    modify (see CLAUDE.md).
    """
    if not model_path.exists():
        raise FileNotFoundError(f"Model file not found: {model_path}")
    actual = compute_model_sha256(model_path)
    if expected_sha256 is not None and not hmac.compare_digest(actual, expected_sha256):
        raise ValueError(
            f"Model integrity check FAILED for {model_path}: "
            f"expected {expected_sha256}, got {actual}."
        )
    return actual


# ------------------------------------------------------------ request IDs --


def new_request_id() -> str:
    return str(uuid.uuid4())
