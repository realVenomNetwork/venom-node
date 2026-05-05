# Project Structure

`venom-network` is the single active project root.

## Active Source

- `aggregator/` - node queue, worker, nonce management, and Libp2p gossip.
- `cli/` - CLI commands (venom binary entry point).
- `contracts/` - all Solidity contracts compiled by Hardhat.
- `contracts/governance/` - council, agreement, consent, and tithe governance modules.
- `dashboard/` - static dashboard.
- `eval_engine/` - Python scoring, calibration, and audit tools.
- `ml_service/` - FastAPI ML scoring service used by Docker Compose.
- `rpc/` - contract/RPC routing helper.
- `scripts/` - deployment and demo scripts.
- `src/` - runtime-mode guardrails, postcard schema, operator card, dashboard utilities.
- `test/` - Hardhat test suite.

## Historical Material

Earlier exploratory notes, worldview-specific governance variants, and pre-generalization
contracts have been moved out of the repository. The current governance design is in
`contracts/governance/CouncilRegistry.sol` and treats all branches as worldview-agnostic
attestation primitives.

Generated or temporary folders are ignored by `.gitignore`: `node_modules`, `artifacts`, `cache`, `tmp`, `offline-artifacts`, and dated export folders.
