# Changelog

## 1.0.1 - 2026-04-27

- Consolidated the prior `venom-node`, `venom-council`, and `venom-tithe` folders into one root project.
- Added governance contracts under `contracts/governance`.
- Fixed `MinimalMultiSig` so confirmations must come from distinct signers.
- Added governance contract tests for multisig, tithe recipient removal, AgreementFactory payable behavior, and slashed stake reserve withdrawal.
- Added Docker hardening, `.dockerignore`, CI, Dependabot, public repo metadata, and clearer testnet economics documentation.
- Moved historical side repos and raw export artifacts under `_archive/`.
- Switched `TitheManager` to pull payments, fixed concurrent `MinimalMultiSig` execution, and allowed per-creed `CreedValidator` attestations.
- Persisted the producer scan cursor in Redis and added JavaScript syntax checks to CI.
