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
    # route. The body below is still the original Phase 4-era echo stub - no
    # real SnarkJS proof is generated yet (that's Phase 7, which now has a
    # real circuit to call - circuits/accuracy.circom, Phase 5/6). This gate
    # is deliberately built to survive that swap unchanged: Phase 7 replaces
    # what happens AFTER validate_proof_request() succeeds, not the security
    # checks before it.
    validate_proof_request(request.claimed_accuracy, request.correct, request.total)

    request_id = new_request_id()
    response.headers["X-Request-ID"] = request_id

    payload = {
        "correct": request.correct,
        "total": request.total,
        "claimed_accuracy": request.claimed_accuracy,
    }
    # TODO: hook real SnarkJS proof generation here (Phase 7).
    proof = dict(payload)

    # Ticket binds this specific (hashed) request to a short-lived, signed,
    # replay-protected token - never the request content itself. Not yet
    # consumed anywhere (no /verify_proof exists yet - Phase 7), but issuing
    # it here demonstrates the mechanism live and end-to-end testable.
    try:
        ticket = issue_ticket(payload, ttl_seconds=300)
    except RuntimeError as exc:
        # ZK_TICKET_SECRET missing - same "fail closed with a clear reason"
        # posture as require_api_key, not a bare unhandled 500.
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    return {
        "status": "success",
        "proof": proof,
        "claimed_accuracy": request.claimed_accuracy,
        "request_id": request_id,
        "ticket": ticket,
    }


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
