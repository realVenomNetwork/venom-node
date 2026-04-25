# VENOM Node v1.0.1

**Decentralized ML-Gated Oracle Network**  
A permissionless, cryptoeconomically secured oracle that evaluates AI-generated content using hybrid deterministic + semantic scoring, Libp2p gossip consensus, and on-chain median slashing.

**Current Version:** v1.0.1 (Security Hotfix)  
**Network:** Base Sepolia Testnet  
**Status:** Production-ready for testnet operators

---

## 🚀 Quick Start (One Command)

```bash
git clone https://github.com/realVenomNetwork/venom-node.git
cd venom-node
cp .env.example .env
# Edit .env with your DEPLOYER_PRIVATE_KEY and RPC_URLS
docker-compose up -d
```

Your node will automatically:
- Stake 1 ETH (testnet)
- Register with its real Libp2p multiaddr
- Join the gossip mesh
- Start evaluating campaigns

---

## v1.0.1 Security Hotfix & Current Limitations

**This release contains a critical security hotfix.**

### What Was Fixed in v1.0.1
- **Slashing Index Corruption Bug** — Fixed a zero-day vulnerability where the in-place bubble sort in `_calculateMedian` could cause incorrect slashing of honest oracles. Signers are now recovered **before** sorting using a parallel `validSigners` array.
- **Operator Bounty Payout** — The 0.001 ETH bounty now correctly goes to the operator whose node submits the aggregated `closeCampaign` transaction.
- **Real Libp2p Bootstrapping** — Nodes now register their actual listening multiaddress instead of a fake one derived from the private key.
- **Docker Environment Variables** — `ML_SERVICE_URL` is now correctly read from the container environment.

### Current Limitations (v1.0.0 / v1.0.1)

> **Important:** All nodes currently evaluate the **same hardcoded test payload** (`GOOD_PAYLOAD` in `aggregator/worker.js`).

- Real campaign content is **not yet fetched** from IPFS or any off-chain store.
- This is **intentional** for the Genesis release so we can validate the consensus and slashing mechanics in a controlled environment.
- A clear warning is logged on every evaluation:  
  `[Worker] Using test payload for <campaignUid> — replace with real content fetch`

**Do not run this with real mainnet ETH until v1.1 (real payload fetching) is live.**

---

## Architecture

- **Smart Contracts**: `PilotEscrow.sol` + `VenomRegistry.sol` (median consensus + 25% slashing)
- **Node Runtime**: Node.js 20 + BullMQ + Libp2p (Gossipsub)
- **ML Engine**: FastAPI + `sentence-transformers/all-MiniLM-L6-v2` (hybrid v5.3.2 scorer)
- **Consensus**: 5-of-N oracle signatures → on-chain median → automatic slashing of outliers

---

## Economic Model (Testnet)

| Parameter          | Value          | Notes |
|--------------------|----------------|-------|
| Stake              | 1 ETH          | Testnet only |
| Bounty per campaign| 0.001 ETH      | Paid to submitting leader |
| Slash penalty      | 25% of stake   | For >25 point deviation from median |

---

## Monitoring

- **Dashboard**: Open `dashboard/index.html` in your browser
- **Logs**: `docker-compose logs -f venom-node`
- **PM2** (recommended for production): `pm2 start ecosystem.config.js`

---

## Security & Best Practices

- Never commit your `.env` file
- Use a dedicated hot wallet for the node (separate from cold storage)
- Monitor for slashing events in logs
- Keep the node updated — v1.1 will introduce real payload fetching

---

## Roadmap

See [docs/ROADMAP.md](docs/ROADMAP.md) for the v1.1 and beyond plan.

---

**License:** MIT  
**Maintained by:** realVenomNetwork  

---

**Genesis Release — April 2026**
