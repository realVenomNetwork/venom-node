# VENOM Network Operator Guide

Run a Base Sepolia testnet oracle node for VENOM Network.

## Quick Start

```bash
git clone https://github.com/realVenomNetwork/venom-network.git
cd venom-network
cp .env.example .env
# Edit .env with RPC_URL, DEPLOYER_PRIVATE_KEY, VENOM_REGISTRY_ADDRESS, and PILOT_ESCROW_ADDRESS.
docker compose up -d --build
```

The node will:

1. Stake `VenomRegistry.MIN_STAKE` if the hot wallet is not registered.
2. Register its Libp2p multiaddr on-chain.
3. Join the gossip mesh.
4. Evaluate and publish signed score or abstain messages.

## Requirements

- Docker + Docker Compose
- 4 GB RAM minimum, 8 GB recommended
- Stable internet connection
- Base Sepolia ETH for gas and the testnet stake

## Environment

```env
RPC_URL=https://base-sepolia-rpc.publicnode.com
DEPLOYER_PRIVATE_KEY=
VENOM_REGISTRY_ADDRESS=
PILOT_ESCROW_ADDRESS=
```

Use a dedicated low-balance hot wallet. Do not use a primary wallet or cold-storage key.

## Monitoring

```bash
docker compose logs -f venom-node
docker compose logs -f ml-service
```

## Current Economics

- Stake required by the current registry: `1 ETH` on testnet.
- Current slash amount: `5%` of registered stake for score deviation beyond `MAX_DEVIATION`.
- Operator bounty payouts are not implemented in the active `PilotEscrow` contract. The current campaign bounty is returned to the campaign recipient recorded at funding time, which is currently the funder.
- Unstaking is not implemented. Treat testnet stake as locked for this release candidate.

## Security Notice

Running a modified node that signs invalid scores can cause the oracle to be marked inactive and slashed by the on-chain median consensus path. Contracts are unaudited and testnet-only.
