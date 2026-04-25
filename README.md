# VENOM Node Operator Guide

**Run a decentralized ML oracle node and earn bounties.**

## Quick Start (One Command)

```bash
git clone https://github.com/venom-network/venom-node.git
cd venom-node
cp .env.example .env
# Edit .env with your RPC_URL and DEPLOYER_PRIVATE_KEY
docker-compose up -d
```

That's it. The node will automatically:

1.  Stake 1 ETH
2.  Register its Libp2p address on-chain
3.  Join the decentralized gossip mesh
4.  Start evaluating and closing campaigns

## Requirements

*   Docker + Docker Compose
*   4 GB RAM minimum (8 GB recommended)
*   Stable internet connection
*   Base Sepolia ETH (for gas + 1 ETH stake)

## Environment Variables (.env)
```env
RPC_URL=https://base-sepolia-rpc.publicnode.com
DEPLOYER_PRIVATE_KEY=0x...
```

## Monitoring
```bash
docker-compose logs -f venom-node
```

## Economics

*   **Bounty per closed campaign**: 0.001 ETH
*   **Stake required**: 1 ETH (slashed 25% on malicious behavior)
*   **Expected ROI**: Highly dependent on campaign volume (see simulator)

## Security Notice
Running a modified node that approves invalid payloads will result in automatic 25% stake slashing via the on-chain median consensus mechanism. This is by design.

## Support
Join the Discord (not available yet) or open an issue on GitHub.
