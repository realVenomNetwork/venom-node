# Canary 04 Entry Point

Resume session from 2026-05-27.

## Solo Test Proven

Solo operator lifecycle fully verified on fresh contracts:

- Registration, campaign discovery, ML scoring (score=69 >= 60 threshold), EIP-712 signing, closeCampaign on-chain
- `closed: true` confirmed at block 42,075,919
- Stale solo stack torn down; infra rebuilt for multi-operator

## Active Deployment

| Contract | Address |
|---|---|
| VenomRegistry | `0xDc24A6C004D17610f7B33A729D300832C97f36Ba` |
| PilotEscrow | `0xBA283BC41dC073092c38f7F3d097d3f168FA588e` |

**Profile:** `canary-04-prod` (defined `scripts/pilot/profiles.js:48`)

| Constant | Value |
|---|---|
| REQUIRED_ORACLES | 4 |
| SCORE_QUORUM_PCT | 50 |
| PARTICIPATION_FLOOR_PCT | 67 |
| MIN_STAKE | 0.05 ETH |
| CAMPAIGN_TIMEOUT_BLOCKS | 3600 |
| bootstrapDiscovery | true |

**Deployer wallet:** `0x470a6DAE08ED6250E42abD22302cd02394622fDE` (~0.0028 ETH remaining)

**Deployment artifact:** `deployments/base-sepolia-canary-04-prod.json`

## Operators

4 generated operators in `.venom-canary-04-prod/operator-{1..4}/.env`. Each env contains the operator's private key.

| Op | Address | Balance | Needs |
|---|---|---|---|
| 1 | `0x119129569459c929913a7334c013d5edbeC973F3` | 0 ETH | 0.07 ETH |
| 2 | `0x0b057FF3627445d35d5611ac3999b667C85A6587` | 0 ETH | 0.07 ETH |
| 3 | `0xe864ABA3FdFfb65070E3d1d18144b8dCF73d2F45` | 0 ETH | 0.07 ETH |
| 4 | `0x3Bedc3865BE00957B18ab7e9B4Da6683a2d7876a` | 0 ETH | 0.07 ETH |

**Funding targets:** `.venom-canary-04-prod/funding-targets.txt`
**Manifest:** `.venom-canary-04-prod/manifest.json`

## Compose

`docker-compose.canary-04-prod.yml` at project root. Includes Redis + ML service + 4 node containers.

```powershell
docker compose --project-name canary-04-prod -f docker-compose.canary-04-prod.yml up -d --build
```

P2P bootstrap peers configured for the 4-node mesh (`VENOM_SKIP_REGISTRY_DIAL=true`, `P2P_BOOTSTRAP_PEERS` set per operator).

## State Files

| Purpose | Path |
|---|---|
| Profile definitions | `scripts/pilot/profiles.js` |
| Deployment script | `scripts/deploy_phase4.js` |
| Operator env generator | `scripts/pilot/make-operator-envs.js` |
| Solo env (reference only) | `.venom-canary-04/operator-1/.env` |
| Solo manifest (reference only) | `.venom-canary-04/manifest.json` |
| Solo artifact (reference only) | `deployments/base-sepolia-canary-04.json` |
| Legacy op sweep keys | `tmp/sweep-wallets.cjs` |
| Test payload | `data/fixtures/good-payload.json` |

## Key Decisions

1. **Fresh contracts for each phase** — avoids 48h PilotEscrow timelock on existing VenomRegistry
2. **Solo profile (REQUIRED_ORACLES=1, minStake=0.05)** — used for the solo lifecycle test before multi-operator
3. **canary-04-prod profile (REQUIRED_ORACLES=4, minStake=0.05)** — matches 0.1 ETH/day faucet budget; ~3 days to fund all 4
4. **bootstrapDiscovery=true** — P2P mesh without registry dial (known working approach)
5. **USE_TEST_PAYLOAD=true during solo test** — avoids IPFS; set false for multi-operator

## ML Scoring

Threshold: `ATTACK_C_PASS_THRESHOLD = 0.60` in `eval_engine/attacks/v51_scoring.py:14`

ML service container `venom-ml-service-canary` reached at `ml-service-canary:8000/evaluate` (compose network). Responded in 68ms during solo test. Container name in compose: `venom-ml-service-canary-04-prod`.

## Results — Full Lifecycle Verified

**Date:** 2026-05-27  
**Network:** Base Sepolia testnet  
**Campaign UID:** `0x1df253ae4ab000d37bf7abcf45ca8e9edcbc6f7fd445ab42162a48ca4be22079`  
**CID:** `QmP8PAqMjjZknLUsgLWqDrJeRAoz6YHmQjYHET4XyTj2B4`  
**Funded block:** 43228563  
**Close block:** 43228583  

### Test Campaigns

| # | UID | Content | Hash | Result |
|---|---|---|---|---|
| 1 | `0x42b09ce...` | Arbitrary text, SHA-256 hash | Mismatch | 4 abstains (HashMismatch) |
| 2 | `0xab5bacc1...` | Raw text, correct keccak256 | Match | Score 0.1 (below 0.60 threshold) |
| 3 | `0xc003ee5b...` | JSON payload + reference_answer | Match | Score 0.59 (0.01 below threshold) |
| 4 | `0x1df253ae...` | Rich JSON payload + reference_answer | Match | Score ≥ 0.60 → **CLOSED** ✅ |

### Lifecycle Log (Campaign 4)

| Step | Status |
|---|---|
| 4 operators funded (0.07 ETH each) | ✅ |
| Docker stack deployed (6 containers) | ✅ |
| All 4 operators registered on-chain | ✅ |
| Producers discovered campaign | ✅ |
| IPFS content fetched via HTTP gateway | ✅ |
| Content hash verified (keccak256) | ✅ |
| ML service scored above 0.60 | ✅ |
| 4/4 signed SCOREs via P2P relay | ✅ |
| Quorum reached, op1 elected leader | ✅ |
| closeCampaign submitted | ✅ |
| Campaign confirmed closed on-chain | ✅ Block **43228583** |

### Key Learnings

1. **Content hash must be keccak256** of the payload string (not SHA-256), computed via ethers.js.
2. **ML model requires structured JSON** with both `payload` and `reference_answer` fields to score above 0.60.
3. **Generic text scores poorly** (~0.1) even with correct hash.
4. **closeCampaign reverts with "No scores provided"** if all votes are abstains — at least one non-abstain score is required.
5. **VENOM_ALLOW_PRIVATE_MULTIADDR=true** needed for single-machine Docker dev (no public multiaddrs).
6. **Publicnode RPC worked reliably** after Tenderly timeouts.
7. **Local IPFS node** within Docker network served content successfully.

### Stack Cleanup

Temp IPFS container removed. Stack may be left running for further testing.

---

## Next Steps (Archived — Session Complete)

```powershell
# 1. Fund 4 operators with 0.07 ETH each (0.28 total, ~3 days faucet)
#    op1: 0x119129569459c929913a7334c013d5edbeC973F3
#    op2: 0x0b057FF3627445d35d5611ac3999b667C85A6587
#    op3: 0xe864ABA3FdFfb65070E3d1d18144b8dCF73d2F45
#    op4: 0x3Bedc3865BE00957B18ab7e9B4Da6683a2d7876a

# 2. Start stack
docker compose --project-name canary-04-prod -f docker-compose.canary-04-prod.yml up -d --build

# 3. Check all 4 operators register on-chain
docker logs venom-node-canary-04-prod-1 --since 30s | Select-String "Registered|stake"

# 4. Fund a campaign (from any funded EOA or one of the operators)
#    Requires: node -e script or direct contract call

# 5. Watch lifecycle
docker logs venom-node-canary-04-prod-1 --since 2m | Select-String "closed|quorum|closeCampaign|SUCCESS"
```

## Operators Deprecated

4 legacy C03 operators deregistered via requestUnstake(). Addresses in `tmp/sweep-wallets.cjs`. Solo operator `0x470a6DAE...` de-registered with the C03 cleanup.

## Contracts Replaced

Previous deployments for reference:

| Profile | Registry | Escrow | Purpose |
|---|---|---|---|
| canary-03 | `0xFd32930562Ff693DEB5338A0FB6bd6113819919F` | `0xa0187DCd014d2465deF3F395b7852Ff1Cb925944` | C03 (replaced) |
| solo | `0xE74440c7777cECe77ED0965d9d3B13aD6271fE98` | `0x6f13A99514ecd5A93673da7E6c48a18d7330D8E5` | Solo test (replaced) |
| canary-04-prod | `0xDc24A6C004D17610f7B33A729D300832C97f36Ba` | `0xBA283BC41dC073092c38f7F3d097d3f168FA588e` | **Active** |
