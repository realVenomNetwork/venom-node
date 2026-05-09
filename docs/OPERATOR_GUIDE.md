# VENOM Node Operator Guide

Run a Base Sepolia testnet oracle node for VENOM Node.

## Quick Start

```bash
git clone https://github.com/realVenomNetwork/venom-node.git
cd venom-node
cp .env.example .env
# Edit .env with RPC_URL, OPERATOR_PRIVATE_KEY, VENOM_REGISTRY_ADDRESS, and PILOT_ESCROW_ADDRESS.
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
OPERATOR_PRIVATE_KEY=
VENOM_REGISTRY_ADDRESS=
PILOT_ESCROW_ADDRESS=
IPFS_GATEWAYS=https://ipfs.io/ipfs,https://dweb.link/ipfs,https://gateway.pinata.cloud/ipfs
ML_SERVICE_API_KEY=<random-strong-secret>
```

Use a dedicated low-balance hot wallet. Do not use a primary wallet, cold-storage key, or the deployment key. `DEPLOYER_PRIVATE_KEY` is deploy-only and the operator runtime rejects it.

For solo, non-production tests on machines without public P2P reachability, set `VENOM_ALLOW_PRIVATE_MULTIADDR=true` to register the node's private libp2p multiaddr. The node logs a warning when this path is used. Do not use it for production pilots; production operators should configure `PUBLIC_MULTIADDR` or port forwarding so other oracles can dial the node.

## Deployment Profiles

Deployments can set `DEPLOY_PROFILE=production`, `DEPLOY_PROFILE=canary-01-5`, or `DEPLOY_PROFILE=solo`. The profile selects bounded constructor values for `VenomRegistry.MIN_STAKE()` and the `PilotEscrow` quorum/timeout getters. `production` is the default when the variable is unset. Runtime operators should read the deployed contract values instead of assuming 5 required oracles or a 1 ETH stake.

## Monitoring

```bash
docker compose logs -f venom-node
docker compose logs -f ml-service
```

## Current Economics

- Stake required by the current registry: read `VenomRegistry.MIN_STAKE()`. The default `production` deploy profile uses `1 ETH`; `canary-01-5` uses `0.1 ETH`.
- Current slash amount: `5%` of registered stake for score deviation beyond `MAX_DEVIATION`.
- Operator bounty payouts are not implemented in the active `PilotEscrow` contract. The current campaign bounty is returned to the campaign recipient recorded at funding time, which is currently the funder.
- Unstaking is implemented with `requestUnstake()` followed by `finalizeUnstake()` after a 7-day cooldown. An oracle can still be slashed during the cooldown, and slashed oracles cannot re-register after finalization.

## Security Notice

Running a modified node that signs invalid scores can cause the oracle to be marked inactive and slashed by the on-chain median consensus path. Contracts are unaudited and testnet-only.

## Before Staking

- Confirm the network is Base Sepolia, chainId `84532`.
- Run `npm run doctor`, `npm run compile`, `npm test`, and `npm run test:cist`.
- Confirm `IPFS_GATEWAYS` and `ML_SERVICE_API_KEY` are set.
- Confirm `ML_SERVICE_API_KEY` is not the `.env.example` sentinel value.
- Set `PREFLIGHT_IPFS_CID` and `PREFLIGHT_IPFS_SHA256` to a small known public payload.
- Confirm `DEPLOYER_PRIVATE_KEY` is not present in the operator environment.
- Confirm active oracle count is at least `PilotEscrow.REQUIRED_ORACLES()` before funding a campaign.
- Run the read-only live preflight before funding:

```bash
npm run pilot:preflight -- --network=base-sepolia
```
