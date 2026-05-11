# Changelog

## Unreleased

### Pre-canary-3 Runtime Readiness

- Added `canary-03` deployment profile constants and shared profile helpers for deploys, operator-env generation, and canary readiness checks.
- Hardened deployment artifacts with schema, chain, profile constant, and registry-to-escrow binding validation before generating operator envs.
- Added persistent per-operator libp2p peer keys via `P2P_KEYSTORE_PATH` and compose-managed keystore volumes.
- Switched libp2p stream muxing to `yamux` and kept canary bootstrap discovery disabled for `canary-03`.
- Added node `/healthz` checks and structured canary event publishing for local dashboard and run diagnostics.
- Made `MultiRpcProvider.getProvider()` fallback-aware for long-lived ethers contract and wallet reads.
- Added worker pending-delivery outbox retry so signed score or abstain deliveries are replayed after Redis/queue interruptions before idempotency is finalized.
- Added explicit BullMQ job lock sizing with validation against fetch plus ML timeout budgets.
- Added scope disclosure to Campaign Postcard v1 artifacts and kept test-payload postcards confined to demo mode.

### Earlier Unreleased Fixes

- Fixed `slowapi` wiring in ML service with explicit `app.state.limiter` assignment and middleware registration.
- Fixed payload wiring so `producer.js` passes `contentHash` from `CampaignFunded` events to workers.
- Fixed `VenomRegistry` timelock collapse so `setPilotEscrow` distinguishes first call from subsequent 48h-timelocked changes.
- Added multiaddr validation that rejects `0.0.0.0`, loopback, and RFC1918 private ranges unless an explicit solo-test override is set.
- Fixed smoke-test strict-mode exit code by gating exit on `effectiveState()` instead of raw phase state.
- Moved worldview-specific governance material to `venom-node-legacy/` sibling repository and removed `CreedValidator` tests.

## v1.6 - 2026-04-28

- Added Campaign Postcard v1 immutable local field notes with `postcard.v1` schema validation and local artifact isolation.
- Added the Oracle Hearth dashboard with node-local Campaign Lanterns, UI-only Quorum Replay, and read-only Redis ACL sentinel checks.
- Added the local-only, regenerable Operator Card at `~/.venom/operator-card.md`; it records configuration, not reputation.
- Added `VENOM_RUNTIME_MODE` and `USE_TEST_PAYLOAD` runtime guardrails plus CI-enforced `roadmap:check`.
- Added final external testing documentation and updated `.env.example` with v1.6 runtime and dashboard variables.

## v1.0.1 - 2026-04-27

- Consolidated prior side folders into one root project.
- Added governance contracts under `contracts/governance`.
- Fixed `MinimalMultiSig` so confirmations must come from distinct signers.
- Added governance contract tests for multisig, tithe recipient removal, AgreementFactory payable behavior, and slashed stake reserve withdrawal.
- Added Docker hardening, `.dockerignore`, CI, Dependabot, public repo metadata, and clearer testnet economics documentation.
- Switched `TitheManager` to pull payments, fixed concurrent `MinimalMultiSig` execution, and expanded governance attestation coverage.
- Persisted the producer scan cursor in Redis and added JavaScript syntax checks to CI.
