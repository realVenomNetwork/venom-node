# ML Service

FastAPI service wrapping the VENOM scoring engine.

## Run Locally

```bash
python -m pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8000
```

Health check:

```bash
curl http://127.0.0.1:8000/health
```

Evaluation endpoint:

```bash
curl -X POST http://127.0.0.1:8000/evaluate \
  -H "Content-Type: application/json" \
  -d '{"payload":"example answer","reference_answer":"expected answer"}'
```

The service loads `sentence-transformers/all-MiniLM-L6-v2` through the evaluation engine and keeps it warm for subsequent requests.
