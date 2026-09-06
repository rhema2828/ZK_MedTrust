"""FastAPI server exposing the medical diagnostics model over HTTP."""

import os
import tempfile

import uvicorn
from fastapi import Depends, FastAPI, File, HTTPException, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from ml_inference import MedicalDiagnosticsModel
from security import (
    enforce_rate_limit,
    issue_ticket,
    new_request_id,
    require_api_key,
    validate_proof_request,
)
from zk_proof import (
    ClaimNotProvableError,
    ZkToolchainNotReadyError,
    generate_accuracy_proof,
    verify_accuracy_proof,
    zk_toolchain_ready,
)

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

model = MedicalDiagnosticsModel()


class ProofRequest(BaseModel):
    claimed_accuracy: int
    correct: int
    total: int


class VerifyProofRequest(BaseModel):
    proof: dict
    public_signals: list[str]


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/predict")
async def predict(file: UploadFile = File(...)):
    tmp_path = None
    try:
        suffix = os.path.splitext(file.filename or "")[1]
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            tmp.write(await file.read())
            tmp_path = tmp.name

        result = model.predict(tmp_path)
        return {"status": "success", "prediction": result}
    except Exception as exc:
        return JSONResponse(
            status_code=500, content={"status": "error", "message": str(exc)}
        )
    finally:
        if tmp_path and os.path.exists(tmp_path):
            os.remove(tmp_path)


@app.post("/generate_proof")
def generate_proof(
    request: ProofRequest,
    response: Response,
    api_key: str = Depends(require_api_key),
    _rate_limit: None = Depends(enforce_rate_limit),
):
    # PHASE 8: authentication, rate limiting, and input validation guard this
    # route, unchanged since Phase 7 replaced only what happens after they
    # succeed.
    #
    # PHASE 7: claimed_accuracy IS the threshold being claimed - "I claim
    # >= claimed_accuracy% accuracy" - matching circuits/accuracy.circom's
    # `threshold` signal. The existing request field name is kept as-is
    # (preserving the API), just given its real meaning now that there is
    # a real circuit to check it against.
    validate_proof_request(request.claimed_accuracy, request.correct, request.total)

    request_id = new_request_id()
    response.headers["X-Request-ID"] = request_id

    if not zk_toolchain_ready():
        raise HTTPException(
            status_code=503,
            detail=(
                "ZK toolchain not initialized - the one-time Groth16 setup for "
                "circuits/accuracy.circom hasn't been run. See zk/README.md's "
                "Phase 5/6 sections (bash scripts/phase5_accuracy.sh or "
                "scripts/phase6_pipeline.sh)."
            ),
        )

    try:
        result = generate_accuracy_proof(
            correct=request.correct, total=request.total, threshold=request.claimed_accuracy
        )
    except ClaimNotProvableError as exc:
        # The circuit's constraints correctly refused this claim - there is
        # no proof to generate for a false statement. This is the security
        # property working, not a server error: 422, not 500.
        raise HTTPException(
            status_code=422,
            detail=(
                f"No proof can be generated: {request.correct}/{request.total} does not "
                f"meet the claimed {request.claimed_accuracy}% threshold, or the inputs "
                f"violate the circuit's range constraints ({exc})."
            ),
        ) from exc
    except ZkToolchainNotReadyError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    payload = {
        "correct": request.correct,
        "total": request.total,
        "claimed_accuracy": request.claimed_accuracy,
    }
    # Ticket binds this specific (hashed) request to a short-lived, signed,
    # replay-protected token - never the request content itself.
    try:
        ticket = issue_ticket(payload, ttl_seconds=300)
    except RuntimeError as exc:
        # ZK_TICKET_SECRET missing - same "fail closed with a clear reason"
        # posture as require_api_key, not a bare unhandled 500.
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    return {
        "status": "success",
        "proof": result["proof"],
        "public_signals": result["publicSignals"],
        "claimed_accuracy": request.claimed_accuracy,
        "request_id": request_id,
        "ticket": ticket,
    }


@app.post("/verify_proof")
def verify_proof(
    request: VerifyProofRequest,
    response: Response,
    api_key: str = Depends(require_api_key),
    _rate_limit: None = Depends(enforce_rate_limit),
):
    # Same security gate as /generate_proof. Deliberately NOT gated by the
    # /generate_proof ticket: Groth16 verification is meant to be re-checkable
    # by anyone, any number of times (that's the point of a public proof) -
    # nonce/replay protection belongs on the request that CREATES a proof,
    # not on checking one that already exists.
    request_id = new_request_id()
    response.headers["X-Request-ID"] = request_id

    if not zk_toolchain_ready():
        raise HTTPException(
            status_code=503,
            detail="ZK toolchain not initialized - see /generate_proof's same check.",
        )

    try:
        verified = verify_accuracy_proof(request.proof, request.public_signals)
    except ZkToolchainNotReadyError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except RuntimeError as exc:
        # The verifier tool itself broke (not "proof didn't verify" - that
        # returns False cleanly from verify_accuracy_proof, it never raises
        # for that case). This is a real 500: something is actually wrong.
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    # Exactly the shape the brief requires, nothing else that could be
    # mistaken for a shortcut around the real check above.
    return {"zk_verified": verified}


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
