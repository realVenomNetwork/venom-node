# Canary 07 — Production-Quorum + Resilience (Base Sepolia)

**Status:** Run plan — not yet executed.
**Network:** Base Sepolia (chainId 84532)
**Profile:** `canary-07` (defined in `scripts/pilot/profiles.js`)
**Operators:** 5 (Docker, single host)
**MIN_STAKE:** 0.15 ETH (matches Canary 06 production economics)
**SLASH_PERCENT:** 5 (production default)
**MAX_DEVIATION:** 25 (production default)
**Budget estimate:** ~0.93 ETH (5×0.15 stake + 0.01 bounties + gas)
**Recommended execution:** On or after 2026-07-04 (post C06 unstake recovery)

---

## Objective

Validate production-quorum operation with 5 operators at production economic parameters, and stress-test resilience paths that cannot be exercised in smaller canaries:

1. **Production quorum close** — all 5 operators score, quorum reached, leader submits `closeCampaign`
2. **Leader failover** — hard-kill the elected leader after scores are gossiped but before on-chain submission; verify fallback leader closes
3. **IPFS gateway failure / timeout** — configure one operator with unreachable gateways; verify it abstains with `Timeout` and the remaining 4 reach quorum
4. **cancelCampaign** — fund a campaign, let it timeout without closing, verify `cancelCampaign` works

Each scenario is independent and can be run sequentially on the same operator set (with `docker compose down -v` between scenarios to clear Redis state).

---

## Prerequisites

### 1. Deploy contracts with `canary-07` profile

```bash
DEPLOY_PROFILE=canary-07 npx hardhat run scripts/deploy_phase4.js --network base-sepolia
```

Produces `deployments/base-sepolia-canary-07.json`. Verify:
- REQUIRED_ORACLES: 5
- SLASH_PERCENT: 5
- MAX_DEVIATION: 25
- MIN_STAKE: 0.15 ETH

### 2. Generate operator envs

```bash
node scripts/pilot/make-operator-envs.js \
  --count=5 \
  --deployment=deployments/base-sepolia-canary-07.json \
  --profile=canary-07 \
  --out=.venom-canary-07 \
  --force
```

### 3. Fund operators

0.17 ETH per operator (0.15 stake + 0.02 gas buffer). With 5 operators: 0.85 ETH total.

**Funding plan:** Use 0.75 ETH from Canary 06 unstake recovery (July 4) + 0.1 ETH faucet accumulation. If insufficient, defer to July 7+.

### 4. Run preflight

```bash
npm run pilot:preflight -- --network=base-sepolia --canary-envs=.venom-canary-07
```

---

## Scenario A — Production Quorum Close

### Objective

All 5 operators score an IPFS-hosted payload, gossip signed scores, detect quorum, and the elected leader submits `closeCampaign` on-chain. This is the baseline production path at scale.

### Steps

1. Start infrastructure:
   ```bash
   docker compose --project-name canary-07 -f docker-compose.canary-07.yml up -d --build
   ```

2. Verify content hash before funding (avoids the hash-mismatch bug from C04/C06):
   ```javascript
   const payload = require('./data/fixtures/good-payload.json');
   const hash = ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(payload.payload)));
   // hash should match the content hash you pass to fundCampaign
   ```

3. Fund a campaign with a real IPFS CID and correct content hash:
   ```bash
   node scripts/fund-campaign.mjs \
     --cid QmcnVkumNjD9L8FSjhLTDoUYnudJ8AdSS8kJVqquEwkcpq \
     --bounty 0.002 \
     --content-hash 0x0d73f10ecca170228c02cd0020bdaa2bd11ffc3932d7ec53de19afe6532bbcd3
   ```

4. Start all 5 operators:
   ```bash
   for i in $(seq 1 5); do
     node register_and_start.js --env .venom-canary-07/operator-$i/.env &
   done
   ```

4. Monitor logs. Expected sequence:
   - Each operator fetches from IPFS, calls ML service
   - Each operator gossips signed score (via `/venom-relay/1.0.0`)
   - At 5/5 scores, quorum met, leader detected
   - Leader calls `closeCampaign` with all 5 EIP-712 signatures + 0 abstains
   - Campaign `closed=true`, median score delivered on-chain

### Verification

```javascript
const campaign = await escrow.campaigns(campaignUid);
// campaign.closed === true
// campaign.medianScore === <expected>
```

---

## Scenario B — Leader Failover

### Objective

After all 5 scores are gossiped but before the elected leader submits on-chain, kill the leader process. Verify a fallback leader detects quorum and submits `closeCampaign`.

### Steps

1. Fund and start as in Scenario A.
2. From operator logs, identify the elected leader **immediately when scores reach 5/5**:
   ```
   Quorum reached (round 0 leader: 0x...)
   ```
   Do **not** wait for the `Submitting closeCampaign` log — by then the tx may already be in the mempool.
3. Kill the leader process within 2-5 seconds of the quorum log (SIGKILL, not SIGTERM):
   ```bash
   kill -9 <leader-pid>
   ```
4. Wait (~30-60s). The remaining 4 operators should:
   - Detect leader absence (no `closeCampaign` tx within expected window)
   - Increment round
   - New leader elected for round 1
   - New leader submits `closeCampaign`
5. Verify on-chain close succeeds. Confirm the `closeCampaign` tx sender is **not** the killed leader's address.

### Expected Behavior

- The `closeCampaign` tx is submitted by the fallback leader (different address)
- Campaign closes with same median score (scores are already gossiped)
- No double-close (contract should revert)

---

## Scenario C — IPFS Abstention

### Objective

One operator is configured with unreachable IPFS gateways. It should abstain with `Timeout`. The remaining 4 operators should still reach quroum and close.

### Steps

1. Before starting the cluster, modify operator-3's `.env` with a **single** unreachable gateway:
   ```env
   IPFS_GATEWAYS=https://192.0.2.1/ipfs
   IPFS_GATEWAY_TIMEOUT=2000
   FETCH_TIMEOUT_MS=3000
   ```
   (192.0.2.1 is reserved "TEST-NET", guaranteed unreachable). Verify with `curl --connect-timeout 2 https://192.0.2.1/ipfs/QmTest`.
   
   **Critical:** Use only one gateway entry (no commas). If multiple gateways are present and one is real, operator-3 may bypass the test and fetch successfully, making the abstention not trigger.

2. Start all 5 operators.
3. Fund a campaign with a real IPFS CID (as in Scenario A).
4. Monitor logs:
   - Operators 1, 2, 4, 5 fetch from IPFS successfully and gossip scores
   - Operator 3's IPFS fetch times out → publishes signed abstain with `Timeout`
   - Quorum detected: 4 scores + 1 abstain
   - Leader submits `closeCampaign` with 4 scores + 1 abstain

### Verification

```javascript
const campaign = await escrow.campaigns(campaignUid);
// campaign.closed === true
// campaign.abstainCount === 1
```

---

## Scenario D — cancelCampaign

### Objective

Fund a campaign but start only 1 operator (not enough for quorum). After `CAMPAIGN_TIMEOUT_BLOCKS` (3600), verify that `cancelCampaign` can be called by the funder or any oracle to refund the bounty.

### Steps

1. `docker compose down -v` to clear state.
2. Fund a campaign:
   ```bash
   node scripts/fund-campaign.mjs \
     --cid QmcnVkumNjD9L8FSjhLTDoUYnudJ8AdSS8kJVqquEwkcpq \
     --bounty 0.002
   ```
3. Start only operator-1.
4. Do not fund additional operators. The campaign will never reach quorum.
5. Wait for `CAMPAIGN_TIMEOUT_BLOCKS` (~2 hours at 2s Base Sepolia blocks). Alternatively, use a local Hardhat fork to speed this up with `evm_increaseTime`.
6. Call `cancelCampaign`:
   ```javascript
   await escrow.cancelCampaign(campaignUid);
   ```
7. Verify bounty returned to funder and `campaign.closed === true`.

---

## Budget

| Item | Amount (ETH) |
|---|---|
| Operator stakes (5 × 0.15) | 0.75 |
| Campaign bounties (2-3 scenarios × 0.002) | ~0.006 |
| Gas (deploy + fund + close ×3 + cancel) | ~0.04 |
| **Total** | **~0.80** |
| Recoverable (5 × 0.15 = 0.75) | 0.75 |

Net cost: ~0.05 ETH (gas + bounties). This is **only feasible after July 4 C06 recovery** (0.75 ETH inflow).

---

## Schedule Recommendation

Run Canary 07 on or after July 7, 2026:
- July 4: `node scripts/finalize-unstake.js` → recover 0.75 ETH
- July 4-6: faucet accumulation adds ~0.3 ETH
- July 7: deploy, fund, execute all 4 scenarios
- July 14: finalize unstake (repeat recovery)

---

## Risk

- **Leader failover not triggered:** If `closeCampaign` succeeds before kill lands, retry with tighter timing or kill earlier (before quorum log)
- **IPFS gateway fallback:** If operator-3's bogus gateway times out but falls through to a real gateway in IPFS_GATEWAYS list, the abstention won't trigger — use a single fake gateway
- **cancelCampaign timeout:** 3600 blocks ≈ 2 hours on Base Sepolia → can run same-day rather than overnight
- **Budget insufficient pre-July 4:** Defer to post-recovery; do not run C07 with < 0.75 ETH
