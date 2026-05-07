"""
VENOM ML Microservice - Phase 3C.1
FastAPI wrapper around v5.3.2 scoring engine
Keeps the all-MiniLM-L6-v2 model warm in memory
"""

import os
import sys
import time
import logging
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Dict, Any

from fastapi import FastAPI, HTTPException, Security, Depends, Request
from fastapi.security import APIKeyHeader
from pydantic import BaseModel, Field, field_validator
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address
from slowapi.middleware import SlowAPIMiddleware
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
ML_SERVICE_API_KEY_SENTINEL = "replace-me-with-a-random-32-byte-hex-value"

# API Key authentication
API_KEY_HEADER = APIKeyHeader(name="X-API-Key", auto_error=False)
limiter = Limiter(key_func=get_remote_address)

def requires_api_key() -> bool:
    runtime_mode = os.getenv("VENOM_RUNTIME_MODE", "").strip().lower()
    node_env = os.getenv("NODE_ENV", "").strip().lower()
    return runtime_mode in {"testnet", "mainnet"} or node_env == "production"

def validate_ml_service_api_key() -> None:
    configured_key = os.getenv("ML_SERVICE_API_KEY", "").strip()
    if not requires_api_key():
        return
    if not configured_key:
        raise RuntimeError("ML_SERVICE_API_KEY is required in testnet/mainnet mode")
    if configured_key == ML_SERVICE_API_KEY_SENTINEL:
        raise RuntimeError("ML_SERVICE_API_KEY is still set to the .env.example sentinel; replace it with a random strong secret")

async def verify_api_key(api_key: str = Security(API_KEY_HEADER)):
    expected_key = os.getenv("ML_SERVICE_API_KEY")
    if not expected_key:
        if requires_api_key():
            raise HTTPException(status_code=503, detail="ML_SERVICE_API_KEY is required in testnet/mainnet mode")
        return api_key
    if not api_key or api_key != expected_key:
        raise HTTPException(status_code=403, detail="Invalid API key")
    return api_key

async def optional_verify_api_key(api_key: str = Security(API_KEY_HEADER)):
    return api_key

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
    print("Starting [ML Service] startup...")
    validate_ml_service_api_key()
    print(f"   Loading semantic model: {SEMANTIC_MODEL_NAME}")

    # Load model into global state (this is the key optimization)
    app.state.semantic_model = build_semantic_scorer()

    print("OK [ML Service] Model loaded successfully and kept warm in memory.")
    yield
    print("Stopping [ML Service] shutdown...")


# ============================================
# FastAPI Application
# ============================================

app = FastAPI(
    title="VENOM ML Microservice",
    description="High-performance scoring service for the Multi-Oracle Aggregator",
    version="3C.1",
    lifespan=lifespan
)

# Wire slowapi rate limiter into the app
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
app.add_middleware(SlowAPIMiddleware)


@app.get("/health", dependencies=[Depends(optional_verify_api_key)])
@limiter.limit("30/minute")
async def health_check(request: Request):
    api_key_configured = bool(os.getenv("ML_SERVICE_API_KEY"))
    if requires_api_key() and not api_key_configured:
        raise HTTPException(status_code=503, detail="ML_SERVICE_API_KEY is required in testnet/mainnet mode")
    return {
        "status": "healthy",
        "model_loaded": hasattr(app.state, "semantic_model"),
        "model_name": SEMANTIC_MODEL_NAME,
        "api_key_configured": api_key_configured
    }


@app.post("/evaluate", response_model=EvaluateResponse, dependencies=[Depends(verify_api_key)], tags=["evaluation"])
@limiter.limit("10/minute")
async def evaluate(request: Request, evaluate_request: EvaluateRequest):
    try:
        start_time = time.time()
        # Use the pre-loaded model from lifespan
        result = score_for_attack_c(
            payload=evaluate_request.payload,
            reference_answer=evaluate_request.reference_answer,
            model=getattr(app.state, "semantic_model", None)
        )
        elapsed = time.time() - start_time

        return EvaluateResponse(
            final_score=result["final_score"],
            passes_threshold=result["passes_threshold"],
            semantic_score=result.get("semantic_score", 0.0),
            deterministic_score=result.get("deterministic_score", 0.0),
            diagnostics={
                "reasons": result.get("reasons", []),
                "cliff_triggered": result.get("cliff_triggered", False),
                "processing_time_ms": int(elapsed * 1000)
            },
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Scoring failed")
        raise HTTPException(status_code=500, detail={
            "error": "Scoring failed",
            "message": str(e) if os.getenv("DEBUG") else "Internal error"
        })


@app.get("/metrics")
@limiter.limit("30/minute")
async def metrics(request: Request):
    """Basic metrics endpoint for monitoring"""
    return {
        "model_loaded": hasattr(app.state, "semantic_model"),
        "model_name": SEMANTIC_MODEL_NAME,
        "status": "operational"
    }


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
