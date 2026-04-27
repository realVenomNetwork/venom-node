# Project Structure

`venom-network` is the single active project root.

## Active Source

- `aggregator/` - node queue, worker, nonce management, and Libp2p gossip.
- `contracts/` - all Solidity contracts compiled by Hardhat.
- `contracts/governance/` - council, agreement, consent, and tithe governance modules.
- `contracts/governance/faith/` - optional faith-specific validation modules.
- `dashboard/` - static dashboard.
- `eval_engine/` - Python scoring, calibration, and audit tools.
- `ml_service/` - FastAPI ML scoring service used by Docker Compose.
- `rpc/` - contract/RPC routing helper.
- `scripts/` - deployment and demo scripts.
- `test/` - Hardhat test suite.

## Historical Material

The former side-folder content has been folded into the active layout. Earlier exploratory notes and obsolete contract variants are preserved under `docs/governance/` when they should not be compiled by Hardhat. Legacy Solidity snippets use `.sol.txt` extensions so compiler scans cannot pick them up. The original side repos and raw export folders are retained under `_archive/` for traceability.

Generated or temporary folders are ignored by `.gitignore`: `node_modules`, `artifacts`, `cache`, `tmp`, `offline-artifacts`, and dated export folders.
