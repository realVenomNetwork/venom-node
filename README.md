# VENOM Node

A pre-testnet decentralized ML-gated oracle network — a careful witness for the boundary between local observation, on-chain state, and simulation. The stack consists of Solidity contracts targeting Base Sepolia, a Node.js aggregator with libp2p gossip, a Python FastAPI ML scoring service, BullMQ + Redis for job queuing, and an optional static dashboard.

## Status

**Pre-testnet release candidate. Not audited. Not production-ready. Active development.**

The codebase has been through internal review rounds and has regression test coverage for known critical paths, but contracts are not deployed on public testnet and the project has not received external security review. Do not deploy with real funds. Do not rely on this for any consequential decision.

Key economic parameters:

- `VenomRegistry.MIN_STAKE` is 1 ETH (testnet).
- `VenomRegistry.SLASH_PERCENT` is 5%.
- `PilotEscrow.fundCampaign()` records the funder as the campaign recipient, so `closeCampaign()` returns the bounty to that address. Operator bounty payouts are not yet implemented.
- Oracle unstaking is implemented with a 7-day cooldown; slashed stake is tracked in `slashedStakeReserve` and can be withdrawn by the registry owner.

## Architecture

**Contracts** — `PilotEscrow` handles campaign funding, EIP-712 score/abstain signature verification, quorum gates (absolute floor, percentage threshold, participation floor), and campaign close or timeout refund. `VenomRegistry` manages oracle registration with stake, active oracle tracking, deviation-based slashing, and unstake cooldown. Governance contracts (`CouncilRegistry`, `AgreementFactory`, `MinimalMultiSig`, `ConsentManager`, `TitheManager`) are compiled and tested but not yet wired into the active escrow payment path.

**Aggregator node** — `producer.js` scans on-chain events for new campaigns and queues them in Redis/BullMQ. `worker.js` picks up jobs, fetches payloads, verifies content hashes, scores via the ML service, and produces EIP-712 signatures. `p2p.js` handles libp2p gossip of score and abstain signatures, deterministic leader election, and quorum-gated on-chain submission.

**ML service** — `ml_service/main.py` is a FastAPI microservice wrapping the scoring engine. It loads `all-MiniLM-L6-v2` into memory at startup and exposes `/evaluate` for payload scoring. The API key auth and rate limiting are wired through `slowapi`.

**Dashboard** — `dashboard/index.html` is a static local dashboard. It reads from the node's health endpoint and Redis.

## Getting Started

### Prerequisites

- Node.js 20+
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
npm run pilot:smoke-test -- --scenario=all-agree
```

Logs land in `tmp/smoke-test/`. Each run produces `report.json` and `report.md` in a timestamped subdirectory. `tmp/smoke-test/latest.txt` points to the most recent run.

## Known Limitations and Open Work

- **Real-payload IPFS fetching** is wired but has not been piloted on live testnet.
- **Slashing surface** is implemented but not yet exercised against adversarial end-to-end scenarios.
- **`CouncilRegistry.rotateCouncil()`** reverts with "Not implemented" — stub only.
- **`aggregator/nonceManager.js`** is unused; pending decision to integrate or remove.
- **`rpc/router.js`** has a minor timer leak on successful calls (non-blocking, low priority).
- **Governance integration** — `ConsentManager` and `TitheManager` are not yet wired into `PilotEscrow.closeCampaign()`. They are deployable and tested but not active in the payment path.
- **No external security audit.** The contracts have internal review coverage but no third-party audit.

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
