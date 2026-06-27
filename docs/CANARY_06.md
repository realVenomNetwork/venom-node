# Canary 06 — Cross-host Multi-Operator Testnet (Base Sepolia)

**Status:** All 5 operators deployed, campaign scored and closed on-chain. Stakes locked in 7-day cooldown.
**Network:** Base Sepolia (chainId 84532)
**Run window:** 2026-06-27 (single-day attended)
**Recovery date:** 2026-07-04 (call `finalizeUnstake` to recover 5×0.15=0.75 ETH)
**Profile:** `canary-06` (defined `scripts/pilot/profiles.js`)

This document is the canonical record of the Canary 06 run. It is written for engineers who were not present during the canary and who need to understand what was tested, what was learned, and what carries forward.

For the canary's detailed run plan see [`CANARY_06.md`](./CANARY_06.md) (the run plan itself — this file supersedes it as the results record).

---

## Summary

Canary 06 was the first cross-host multi-operator canary using Docker Desktop (host) + Hyper-V VMs as operator hosts. Its goals were:

1. Validate cross-host P2P mesh formation via bootstrap discovery (`VENOM_SKIP_REGISTRY_DIAL=true` + `P2P_BOOTSTRAP_PEERS`)
2. Validate the full campaign lifecycle across a mixed Docker + bare-node topology
3. Validate IPFS content fetch, ML scoring, signed score aggregation, and on-chain closeCampaign with 5 operators

All goals were achieved.

### Headline results

| Dimension | Result |
|---|---|
| Dual-host topology (Docker + Hyper-V VM) | Validated |
| Cross-host P2P bootstrap discovery | Validated (6 connections/op at steady state) |
| IPFS content fetch + content hash verification | Validated |
| ML service scoring across host boundary | Validated (44ms response) |
| 5/5 unanimous signed scores (all cast 69) | Validated |
| P2P score gossip + quorum detection | Validated |
| on-chain closeCampaign by elected leader | Validated |
| Unanimous abstention path (first campaign with wrong hash) | Validated |
| Campaign postcard artifact written to disk | Validated |
| 5/5 requestUnstake submitted on-chain | Completed |

### Budget

| Item | Amount (ETH) |
|---|---|
| Operator stakes (5 × 0.15) | 0.85 |
| Campaign bounties (2 × 0.001) | 0.002 |
| Deploy + funding gas (estimated) | ~0.003 |
| **Total testnet ETH consumed** | **~0.89 of 0.889 funded** |
| Recoverable via finalizeUnstake | 0.75 |

---

## Contracts (chain ID 84532)

| Contract | Address |
|---|---|
| VenomRegistry | `0xab82be024Bde3f302537C5C6A50C1A86880bFc63` |
| ConsentManager | `0xD08B92D28510803BBB18fb52F298433df23d088C` |
| TitheManager | `0xed86628C8542e3252a594612Ab97B3E02e4fE058` |
| PilotEscrow | `0x8eB21BaD606DDBBE5364cc96E9E6839e71afd1d4` |

Deployment artifact: `deployments/base-sepolia.json` (gitignored).

### Profile Constants

| Constant | Value |
|---|---|
| REQUIRED_ORACLES | 5 |
| SCORE_QUORUM_PCT | 50 |
| PARTICIPATION_FLOOR_PCT | 67 |
| CAMPAIGN_TIMEOUT_BLOCKS | 3600 |
| MIN_STAKE | 0.15 ETH |
| SLASH_PERCENT | 5 |
| MAX_DEVIATION | 25 |
| PASS_THRESHOLD | 60 |
| UNSTAKE_COOLDOWN | 7 days |

---

## Operators

5 operator wallets generated under `.venom-canary-06/operator-{1..5}/.env` (gitignored).

### Topology

| Op | Host | Type | P2P port | Queue suffix |
|---|---|---|---|---|
| op1 | Windows host (Docker) | Docker container | 42001 | op1 |
| op2 | Windows host (Docker) | Docker container | 42002 | op2 |
| op3 | Hyper-V VM (172.31.36.169) | bare `node register_and_start.js` | 42003 | op3 |
| op4 | Hyper-V VM (172.31.43.34) | bare `node register_and_start.js` | 42004 | op4 |
| op5 | Hyper-V VM (172.31.47.215) | bare `node register_and_start.js` | 42005 | op5 |

All operators shared a single Redis instance and ML service on the Windows host, reachable by VMs via `172.31.32.1` (Default Switch gateway).

### Operator addresses

```
op1  0xd084499d1Be44723aDbB75C96ACe5Afee6bBf5a9
op2  0xbFaA67F2479f4fb5002096c5F5481Ef0b7aADdb6
op3  0xAB8d47F08acf197ef2C44b764229462d391f6e08
op4  0x9c042e7F437Bada3a6c637425a48Bcb345993938
op5  0xd208067F40883006F99192a5BE68e77DB6AaB9fb
```

Deployer/funder: `0x7d2585E019CB960080F3bDaadca2091e2B5866f9`

---

## Campaigns

### Campaign 1 (hash-mismatch test) — `0xca491d6b...`

| Field | Value |
|---|---|
| Campaign UID | `0xca491d6ba1091372548c640db0dfcf8513dbc5221cd102709753fa1d9b433ae3` |
| CID | `QmcnVkumNjD9L8FSjhLTDoUYnudJ8AdSS8kJVqquEwkcpq` |
| Content Hash provided | `0xb3d10777...` (wrong: hash of entire JSON, not just `.payload`) |
| Bounty | 0.001 ETH |
| Funded block | 43398162 |
| Result | All 5 operators abstained (HashMismatch). closeCampaign with 5 abstains submitted repeatedly by fallback leaders. |

### Campaign 2 (successful close) — `0x84cecc02...`

| Field | Value |
|---|---|
| Campaign UID | `0x84cecc02d8ed5dff93ed1000e18b3e3fd3e8778f48641c011f5ebdafc5adad8b` |
| CID | `QmcnVkumNjD9L8FSjhLTDoUYnudJ8AdSS8kJVqquEwkcpq` |
| Content Hash | `0x0d73f10ecca170228c02cd0020bdaa2bd11ffc3932d7ec53de19afe6532bbcd3` (keccak256 of `.payload` field) |
| Bounty | 0.001 ETH |
| Funded block | 43398218 |
| Closed | true |
| Median score | 69 (unanimous) |
| Leader | op1 (`0xd084499d...`) |
| closeCampaign tx | submitted by op1; confirmed on-chain |

### Pipeline trace (from op1 logs)

```
-> Queued campaign: 0x84cecc...
[Worker] Processing 0x84cecc...
Successfully fetched from https://ipfs.io/ipfs
ML service responded in 44ms
Evaluated and signed score 69
Received SCORE for 0x84cecc... (5/5)
Quorum reached (round 0 leader: 0xd084...)
Submitting closeCampaign for 0x84cecc... with 5 scores + 0 abstains...
Wrote Campaign Postcard v1 for 0x84cecc...
```

### On-chain verification

```javascript
const campaign = await escrow.campaigns("0x84cecc02d8ed5dff93ed1000e18b3e3fd3e8778f48641c011f5ebdafc5adad8b");
// { closed: true, bounty: 0.001 ETH, medianScore: 69, ... }
```

---

## Infrastructure & Configuration

### Cross-host P2P discovery

Bootstrap discovery used `P2P_BOOTSTRAP_PEERS` with `VENOM_SKIP_REGISTRY_DIAL=true`. Each operator's `.env` listed all other operators' `/ip4/.../tcp/...` multiaddrs as bootstrap peers. This avoided on-chain multiaddr lookup which had been unreliable in prior canaries.

At steady state each operator reported `connections=6` (all 4 peers + redundant connections).

### IPFS gateways

Configured on all operators:
```
IPFS_GATEWAYS=https://ipfs.io/ipfs,https://dweb.link/ipfs,https://gateway.pinata.cloud/ipfs
```

### RPC

Archive access was required for `eth_getLogs` (event scanning). `publicnode.com` does not support archive queries; switched to `https://sepolia.base.org`.

### Operator start scripts (Hyper-V VMs)

Each VM had `~/start-op.sh` (not in git — created manually on each VM):
```bash
#!/bin/bash
cd ~/venom-node && nohup node register_and_start.js > /tmp/op{3,4,5}.log 2>&1 &
```

---

## Stake Recovery

### Current status

All 5 operators called `requestUnstake()` at block ~43398319 (2026-06-27T12:55:26Z).

| Op | Address | Stake | Active | UnstakeRequestedAt |
|---|---|---|---|---|
| op1 | `0xd084...` | 0.15 ETH | false | 1782564926 |
| op2 | `0xbFaA...` | 0.15 ETH | false | 1782564928 |
| op3 | `0xAB8d...` | 0.15 ETH | false | 1782564930 |
| op4 | `0x9c04...` | 0.15 ETH | false | 1782564936 |
| op5 | `0xd208...` | 0.15 ETH | false | 1782564942 |

### Recovery procedure (2026-07-04 or later)

```bash
cd ~/venom-node
node scripts/finalize-unstake.js
```

The script at `scripts/finalize-unstake.js`:

1. Reads `VENOM_REGISTRY_ADDRESS` and `RPC_URL` from `.env`
2. Loads all 5 operator private keys from `.venom-canary-06/operator-{1..5}/.env`
3. For each operator, checks `oracles(address)` and `unstakeRequestedAt(address)`
4. If `active=false`, `unstakeRequestedAt > 0`, and 7-day cooldown elapsed:
   - Calls `finalizeUnstake()` via the operator's wallet
5. Verifies `UnstakeFinalized` events

Expected result: 5 × 0.15 = **0.75 ETH** returned to operator wallets.

### Prerequisites

- RPC at `https://sepolia.base.org` reachable
- `ethers` installed (`npm ci` in repo root)
- `.env` file present with `VENOM_REGISTRY_ADDRESS` and `RPC_URL` (or `RPC_URLS`)
- `.venom-canary-06/operator-{1..5}/.env` files present with `OPERATOR_PRIVATE_KEY`

---

## Key Decisions

| Decision | Rationale |
|---|---|
| Hyper-V VMs instead of VMware | Hyper-V already active on Win11; VMware Player incompatible with Hyper-V |
| Bootstrap discovery path | Avoided on-chain multiaddr lookup which had field-ordering issues in prior canaries |
| RPC from publicnode.com to sepolia.base.org | publicnode.com lacks archive support for eth_getLogs |
| Content hash on `.payload` field only | Contract stores `keccak256(payload)`, not hash of the full JSON envelope |
| All operators share host Redis/ML | Simplifies topology; VMs reach services via 172.31.32.1 |

---

## Files of Interest

| Path | Purpose |
|---|---|
| `scripts/pilot/profiles.js` | `canary-06` profile definition |
| `docker-compose.canary-06-host.yml` | Host compose (gitignored) |
| `.venom-canary-06/operator-{1..5}/.env` | Operator keys and config (gitignored) |
| `scripts/finalize-unstake.js` | Recovery script for unstaking |
| `deployments/base-sepolia.json` | Deployment artifact (gitignored) |
| `.env` | Shared config (gitignored) |
| `docs/CANARY_06.md` | This document |
