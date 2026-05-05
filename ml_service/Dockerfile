FROM python:3.11-slim
WORKDIR /app

# Build from repo root context to access eval_engine
COPY ml_service/requirements.txt ./ml_service/requirements.txt
# === Heavy ML dependency layer (monitored) ===
RUN echo "=== [ml-service] Starting pip install of requirements.txt ===" && \
    pip install \
      --progress-bar=off \
      --no-cache-dir \
      --log /tmp/pip-install.log \
      -r ml_service/requirements.txt 2>&1 | tee /tmp/pip-install.log && \
    echo "=== [ml-service] pip install completed successfully ===" && \
    cat /tmp/pip-install.log | tail -n 30
RUN python -c "import torch; import transformers; import sentence_transformers; print('=== [ml-service] All critical ML imports successful ===')" && \
    echo "=== [ml-service] Build verification passed ==="

# Copy only needed directories
COPY ml_service/ ./ml_service/
COPY eval_engine/ ./eval_engine/
COPY data/ ./data/

CMD ["uvicorn", "ml_service.main:app", "--host", "0.0.0.0", "--port", "8000"]
