"""
VENOM ML Microservice - Phase 3C.1
FastAPI wrapper around v5.3.2 scoring engine
Keeps the all-MiniLM-L6-v2 model warm in memory
"""

import os
import sys
import logging
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Dict, Any

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field, field_validator
import uvicorn

# Add project root to path so we can import v51_scoring
REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from eval_engine.attacks.v51_scoring import (
    score_for_attack_c,
    build_semantic_scorer,
    SEMANTIC_MODEL_NAME
)

MAX_EVALUATE_TEXT_LENGTH = int(os.getenv("MAX_EVALUATE_TEXT_LENGTH", os.getenv("MAX_PAYLOAD_BYTES", "51200")))
MAX_EVALUATE_BYTES = int(os.getenv("MAX_EVALUATE_BYTES", os.getenv("MAX_PAYLOAD_BYTES", "51200")))
logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(name)s %(levelname)s %(message)s",
)
logger = logging.getLogger("venom.ml_service")

# ============================================
# Pydantic Schemas (must match Node.js daemon expectations)
# ============================================

class EvaluateRequest(BaseModel):
    payload: str = Field(
        ...,
        min_length=1,
        max_length=MAX_EVALUATE_TEXT_LENGTH,
        description="The adversarial or honest payload to evaluate",
    )
    reference_answer: str = Field(
        ...,
        max_length=MAX_EVALUATE_TEXT_LENGTH,
        description="Reference answer for semantic comparison",
    )
    campaign_uid: str | None = Field(None, description="Optional campaign identifier for logging")

    @field_validator("payload", "reference_answer")
    @classmethod
    def enforce_utf8_byte_limit(cls, value: str) -> str:
        if len(value.encode("utf-8")) > MAX_EVALUATE_BYTES:
            raise ValueError(f"text exceeds {MAX_EVALUATE_BYTES} UTF-8 bytes")
        return value


class EvaluateResponse(BaseModel):
    status: str = "success"
    final_score: float
    passes_threshold: bool
    semantic_score: float
    deterministic_score: float
    diagnostics: Dict[str, Any]
    model_version: str = "v5.3.2"


# ============================================
# Lifespan: Load model exactly once at startup
# ============================================

@asynccontextmanager
async def lifespan(app: FastAPI):
    print("🚀 [ML Service] Starting up...")
    print(f"   Loading semantic model: {SEMANTIC_MODEL_NAME}")
    
    # Load model into global state (this is the key optimization)
    app.state.semantic_model = build_semantic_scorer()
    
    print("✅ [ML Service] Model loaded successfully and kept warm in memory.")
    yield
    print("🛑 [ML Service] Shutting down...")


# ============================================
# FastAPI Application
# ============================================

app = FastAPI(
    title="VENOM ML Microservice",
    description="High-performance scoring service for the Multi-Oracle Aggregator",
    version="3C.1",
    lifespan=lifespan
)


@app.get("/health")
async def health_check():
    return {
        "status": "healthy",
        "model_loaded": hasattr(app.state, "semantic_model"),
        "model_name": SEMANTIC_MODEL_NAME
    }


@app.post("/evaluate", response_model=EvaluateResponse)
async def evaluate(request: EvaluateRequest):
    try:
        # Use the pre-loaded model from lifespan
        result = score_for_attack_c(
            payload=request.payload,
            reference_answer=request.reference_answer,
            model=getattr(app.state, "semantic_model", None)
        )

        return EvaluateResponse(
            final_score=result["final_score"],
            passes_threshold=result["passes_threshold"],
            semantic_score=result.get("semantic_score", 0.0),
            deterministic_score=result.get("deterministic_score", 0.0),
            diagnostics={
                "reasons": result.get("reasons", []),
                "cliff_triggered": result.get("cliff_triggered", False)
            },
        )

    except Exception:
        logger.exception("Scoring failed")
        raise HTTPException(status_code=500, detail="Scoring failed")


# ============================================
# Run with: uvicorn ml_service.main:app --host 0.0.0.0 --port 8000
# ============================================

if __name__ == "__main__":
    uvicorn.run(
        "ml_service.main:app",
        host="0.0.0.0",
        port=8000,
        reload=False,           # Set to True only during development
        log_level="info"
    )
