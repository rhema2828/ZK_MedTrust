"""FastAPI server exposing the medical diagnostics model over HTTP."""

import os
import tempfile

import uvicorn
from fastapi import FastAPI, File, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from ml_inference import MedicalDiagnosticsModel

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
def generate_proof(request: ProofRequest):
    # TODO: hook real SnarkJS proof generation here.
    proof = {
        "correct": request.correct,
        "total": request.total,
        "claimed_accuracy": request.claimed_accuracy,
    }
    return {
        "status": "success",
        "proof": proof,
        "claimed_accuracy": request.claimed_accuracy,
    }


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
