# VENOM Node

A pre-testnet decentralized ML-gated oracle network — a careful witness for the boundary between local observation, on-chain state, and simulation. The stack consists of Solidity contracts targeting Base Sepolia, a Node.js aggregator with libp2p gossip, a Python FastAPI ML scoring service, BullMQ + Redis for job queuing, and an optional static dashboard.

## Status

**Pre-testnet release candidate. Not audited. Not production-ready. Active development.**

The codebase has been through internal review rounds and has regression test coverage for known critical paths, but contracts have not received external security review. Do not deploy with real funds. Do not rely on this for any consequential decision.

Contracts are deployed on **Base Sepolia** (chain 84532) and have been exercised across six canary runs. The most recent — **Canary 06** — validated the full pipeline with 5 operators across Docker Desktop and Hyper-V VMs: cross-host P2P mesh via bootstrap discovery, real IPFS content fetch, ML scoring, signed score gossip, quorum-gated on-chain campaign close, and unanimous abstention handling.

Key economic parameters:

- `VenomRegistry.MIN_STAKE` is set per deployment via profile constants. Profiles range from 0.05 ETH (solo) to 1.0 ETH (production default). See `scripts/pilot/profiles.js` for the canonical set.
- `VenomRegistry.SLASH_PERCENT` is 5%.
- `PilotEscrow.fundCampaign()` records the funder as the campaign recipient, so `closeCampaign()` returns the bounty to that address. Operator bounty payouts are not yet implemented.
- Oracle unstaking is implemented with a 7-day cooldown; slashed stake is tracked in `slashedStakeReserve` and can be withdrawn by the registry owner only after a 48h withdrawal timelock.

## Canary History

Controlled canary runs exercise the full operator pipeline on Base Sepolia testnet with progressively more realistic topologies and economics. Each run produces a results document with contracts, operator addresses, logs, and recovery procedures.

| Canary | Date | Operators | Topology | MIN_STAKE | Outcome |
|---|---|---|---|---|---|
| 01 | 2026-05 | 1 (solo) | Docker | 1.0 ETH | Solo lifecycle validated; live closeCampaign on-chain |
| 01.5 | 2026-05 | 3 | Docker | 0.1 ETH | Multi-op queue isolation, registration; P2P mesh deferred |
| 03 | 2026-05 | 4 | Docker | 0.25 ETH | Multi-op P2P relay, abstain quorum, leader fallback validated |
| 04 | 2026-05 | 1 (solo) | Docker | 0.25 ETH | Solo regression on fresh deployment |
| 06 | 2026-06 | 5 | Docker + Hyper-V VMs | 0.15 ETH | Cross-host P2P mesh, IPFS fetch, ML scoring, on-chain close; stakes in 7d cooldown |

Canary 02 and 05 were scoped but not run. See `scripts/pilot/profiles.js` for all profile definitions.

Key results documents:
- [Canary 06 (latest)](docs/CANARY_06.md) — cross-host validation, full pipeline trace, unstake recovery
- [Canary 03](docs/CANARY_03_RESULTS.md) — multi-operator P2P relay and abstain quorum
- [Canary 01.5](docs/CANARY_01_5_RESULTS.md) — first multi-operator, queue isolation
- [Canary 01](docs/CANARY_01_RESULTS.md) — solo foundation

## Architecture

**Contracts** — `PilotEscrow` handles campaign funding, EIP-712 score/abstain signature verification, quorum gates (absolute floor, percentage threshold, participation floor), and campaign close or timeout refund. `VenomRegistry` manages oracle registration with stake, active oracle tracking, deviation-based slashing, unstake cooldown, and timelocked slashed-stake withdrawals. `CouncilRegistry` supports 48h-timelocked council rotation from per-branch top validators. Governance contracts (`CouncilRegistry`, `AgreementFactory`, `MinimalMultiSig`, `ConsentManager`, `TitheManager`) are compiled and tested but not yet wired into the active escrow payment path.

**Aggregator node** — `producer.js` scans on-chain events for new campaigns and queues them in Redis/BullMQ. `worker.js` picks up jobs, fetches payloads, verifies content hashes, scores via the ML service, and produces EIP-712 signatures. `p2p.js` handles libp2p gossip of score and abstain signatures, deterministic leader election, and quorum-gated on-chain submission.

**ML service** — `ml_service/main.py` is a FastAPI microservice wrapping the scoring engine. It loads `all-MiniLM-L6-v2` into memory at startup and exposes `/evaluate` for payload scoring. The API key auth and rate limiting are wired through `slowapi`.

**Dashboard** — `dashboard/index.html` is a static local dashboard. It reads node-published Redis events; node health endpoints are exposed separately for operator monitoring.

## Getting Started

### Prerequisites

- Node.js 22+
- Python 3.11+
- Docker and Docker Compose
- Hardhat (installed via `npm ci`)

### Local fixture mode (no testnet funds required)

1. Clone and set up the environment:

```bash
git clone <repo-url>
cd venom-node
cp .env.example .env
```

Set `VENOM_RUNTIME_MODE=demo` and `USE_TEST_PAYLOAD=true` in `.env` for safe local operation. `OPERATOR_PRIVATE_KEY` can be left empty for fixture-only work.

2. Install dependencies and run the test suite:

```bash
npm ci
npm run compile
npm test
```

3. Start the full local stack:

```bash
docker compose up -d --build
```

4. Run the component integration smoke test:

```bash
npm run pilot:smoke-test -- --scenario=all-agree --with-fixture-clients
```

Logs land in `tmp/smoke-test/`. Each run produces `report.json` and `report.md` in a timestamped subdirectory. `tmp/smoke-test/latest.txt` points to the most recent run.

For a read-only Base Sepolia preflight against real RPC, Redis, ML, IPFS gateways, contract bytecode, active-oracle count, and operator balance:

```bash
npm run pilot:preflight -- --network=base-sepolia
```

For the most recent canary results and recovery procedures, see [docs/CANARY_06.md](docs/CANARY_06.md). For the public pre-canary runbook, see [docs/CANARY_03.md](docs/CANARY_03.md).

## Known Limitations and Open Work

- **Real-payload IPFS fetching** was piloted on Base Sepolia in Canary 06 with a CID uploaded to the public IPFS network. Multiple gateway fallbacks and content-hash verification were exercised.
- **Slashing surface** is implemented but not yet exercised against adversarial end-to-end scenarios on live testnet. A controlled slashing script exists (`scripts/pilot/slashing-scenario.js`).
- **Cross-host P2P mesh** was validated in Canary 06 (Docker + Hyper-V VMs via bootstrap discovery). This was the first canary to use `VENOM_SKIP_REGISTRY_DIAL=true` and `P2P_BOOTSTRAP_PEERS` for discovery.
- **Governance integration** — `ConsentManager` and `TitheManager` are not yet wired into `PilotEscrow.closeCampaign()`. They are deployable and tested but not active in the payment path.
- **No external security audit.** The contracts have internal review coverage but no third-party audit.
- **Unstaking cooldown** for Canary 06 operators expires 2026-07-04. Run `node scripts/finalize-unstake.js` to recover 5×0.15=0.75 ETH.

## Repository Layout

```
venom-node/
  aggregator/         Node runtime: producer, worker, p2p gossip, queue
  cli/                CLI commands (venom binary)
  contracts/          Solidity: escrow, registry, governance
  dashboard/          Static operator dashboard
  data/               Small fixtures for prompt audits
  docs/               Architecture, roadmap, operator guide, governance notes
  eval_engine/        Python scoring and calibration tools
  ml_service/         FastAPI ML scoring microservice
  rpc/                RPC routing and failover
  scripts/            Deployment scripts and CIST smoke-test harness
  src/                Runtime-mode guardrails, postcard schema, operator card utilities
  test/               Hardhat test suite
```

## Contributing

The maintainer is actively developing this project. External contributions, issues, and forks are welcome. PRs touching consensus logic, slashing, or contract code should include regression tests in `test/`. Run `npm test` and `npm run roadmap:check` before submitting.

## License

MIT. See [LICENSE](LICENSE) for details.

## Acknowledgements

Developed with assistance from multiple AI coding tools used as drafting and review aids; all design decisions, integration, and final code review are by the maintainer.
