# Prompt Fixtures

The prompt integrity audit defaults to `data/prompts/public.json` and `data/prompts/rotating.json`.

These files are small fixtures so a fresh checkout can run:

```bash
python eval_engine/tools/audit_prompt_integrity.py
```

Replace them with the real public and rotating prompt pools before calibration or release evaluations.
