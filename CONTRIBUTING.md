# Contributing

This repository contains Solidity contracts, a Node.js oracle runtime, and Python evaluation tooling. Keep changes scoped and include verification steps in pull requests.

## Local Checks

```bash
npm ci
npm run compile
npm test
python eval_engine/tools/audit_prompt_integrity.py
```

## Guidelines

- Do not commit `.env`, private keys, generated artifacts, caches, or local model output.
- Add or update tests for contract behavior changes.
- Keep governance experiments under `contracts/governance` and `docs/governance`.
- Keep generated or historical material in `_archive/`, which is intentionally ignored.
- Treat smart-contract changes as security-sensitive, even for testnet releases.
