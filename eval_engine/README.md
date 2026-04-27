# Evaluation Engine

`eval_engine/` contains offline scoring, calibration, and audit tools used to develop the VENOM ML evaluation policy.

The Docker runtime imports the scoring implementation through `ml_service/main.py`, but most files in this directory are research and calibration utilities rather than always-on node services.

Useful checks:

```bash
python eval_engine/tools/audit_prompt_integrity.py
python eval_engine/quick_test_harness.py
```

The prompt integrity audit defaults to `data/prompts/public.json` and `data/prompts/rotating.json`. The committed files are small fixtures; replace them with the real prompt pools for release calibration.
