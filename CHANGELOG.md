# Changelog

## UX Layer v1.6 - 2026-04-28

- Added Campaign Postcard v1 immutable local field notes with `postcard.v1` schema validation and local artifact isolation.
- Added the Oracle Hearth dashboard with node-local Campaign Lanterns, UI-only Quorum Replay, and read-only Redis ACL sentinel checks.
- Added the local-only, regenerable Operator Card at `~/.venom/operator-card.md`; it records configuration, not reputation.
- Added `VENOM_RUNTIME_MODE` and `USE_TEST_PAYLOAD` runtime guardrails plus CI-enforced `roadmap:check`.
- Added final external testing documentation and updated `.env.example` with v1.6 runtime and dashboard variables.

## 1.0.1 - 2026-04-27

- Consolidated the prior `venom-node`, `venom-council`, and `venom-tithe` folders into one root project.
- Added governance contracts under `contracts/governance`.
- Fixed `MinimalMultiSig` so confirmations must come from distinct signers.
- Added governance contract tests for multisig, tithe recipient removal, AgreementFactory payable behavior, and slashed stake reserve withdrawal.
- Added Docker hardening, `.dockerignore`, CI, Dependabot, public repo metadata, and clearer testnet economics documentation.
- Moved historical side repos and raw export artifacts under `_archive/`.
- Switched `TitheManager` to pull payments, fixed concurrent `MinimalMultiSig` execution, and allowed per-creed `CreedValidator` attestations.
- Persisted the producer scan cursor in Redis and added JavaScript syntax checks to CI.
