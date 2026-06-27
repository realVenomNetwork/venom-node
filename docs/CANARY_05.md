# Canary 05 — Slashing Validation (Base Sepolia)

**Status:** Run plan — not yet executed.
**Network:** Base Sepolia (chainId 84532)
**Profile:** `canary-05` (defined in `scripts/pilot/profiles.js`)
**Operators:** 3 (all Docker, single host)
**MIN_STAKE:** 0.10 ETH
**SLASH_PERCENT:** 10 (double production default — exercise the event path)
**MAX_DEVIATION:** 20 (tighter than production 25 — guarantee trigger)
**Budget estimate:** ~0.33 ETH (3×0.10 stake + 0.005 bounty + gas)

---

## Objective

Validate the deviation-based slashing path end-to-end: operator submits a score exceeding `MAX_DEVIATION` from the median, `PilotEscrow.reportDeviation()` calls `VenomRegistry.slashOperator()`, the `OracleSlashed` event fires, stake is reduced and moved to `slashedStakeReserve`, and the operator is deactivated.

This is the first live test of the slashing path. All 9 external model analyses (Claude, Gemini, Grok, Kimi, MiniMax, Mistral, Muse, Qwen, ChatGPT) flagged slashing as the #1 unvalidated live path.

---

## Prerequisites

### 1. Modify `scripts/pilot/slashing-scenario.js`

The current script hardcodes `targetIndex = 3` (4th operator, 0-indexed) and requires `operators.length < 4`. For a 3-operator canary, apply these changes:

- Line 172: `if (operators.length < 4)` → `if (operators.length < 3)`
- Line 222: `const targetIndex = 3;` → `const targetIndex = 2;`

Alternatively, make `targetIndex` configurable via `--target-index` flag. The 3rd operator (index 2) will receive the injected deviating score.

### 2. Deploy contracts with `canary-05` profile

```bash
DEPLOY_PROFILE=canary-05 npx hardhat run scripts/deploy_phase4.js --network base-sepolia
```

This produces `deployments/base-sepolia-canary-05.json`. Verify constants:
- REQUIRED_ORACLES: 3
- SLASH_PERCENT: 10
- MAX_DEVIATION: 20
- MIN_STAKE: 0.10 ETH

### 3. Generate operator envs

```bash
node scripts/pilot/make-operator-envs.js \
  --count=3 \
  --deployment=deployments/base-sepolia-canary-05.json \
  --profile=canary-05 \
  --out=.venom-canary-05 \
  --force
```

### 4. Fund operators and deployer

Recommended: 0.12 ETH per operator (0.10 stake + 0.02 gas buffer). Fund from faucet accumulation (0.1 ETH/day).

### 5. Run preflight

```bash
npm run pilot:preflight -- --network=base-sepolia --canary-envs=.venom-canary-05
```

---

## Execution

### Step 1 — Start infrastructure

```bash
docker compose --project-name canary-05 -f docker-compose.canary-05.yml up -d --build
```

### Step 2 — Start 3 operator nodes

Each operator uses its own `.venom-canary-05/operator-{1..3}/.env`. Start all 3 with `register_and_start.js`:

```bash
node register_and_start.js --env .venom-canary-05/operator-1/.env
node register_and_start.js --env .venom-canary-05/operator-2/.env
node register_and_start.js --env .venom-canary-05/operator-3/.env
```

Verify each registers on-chain (check `activeOracleCount` = 3).

### Step 3 — Run slashing scenario

```bash
node scripts/pilot/slashing-scenario.js --profile=canary-05 --deviation=30
```

The script:
1. Funds a campaign (0.005 ETH bounty) with a known payload and content hash
2. Operator 3 (index 2) receives `VENOM_TEST_INJECT_SCORE` = median(70) + deviation(30) = 100
3. Operators 1 and 2 compute and sign the correct score (~70)
4. The aggregator detects deviation > MAX_DEVIATION (20), calls `reportDeviation`
5. `VenomRegistry.slashOperator()` fires `OracleSlashed` with 10% of stake
6. Operator 3 is deactivated

### Step 4 — Verify on-chain

```javascript
const registry = new ethers.Contract(registryAddress, VENOM_REGISTRY_ABI, provider);
const oracle = await registry.oracles(operator3Address);
// oracle.active === false
// oracle.stake === 0.09 ETH (0.10 - 10%)

const reserve = await registry.slashedStakeReserve();
// reserve === 0.01 ETH

const slashed = await registry.everSlashed(operator3Address);
// slashed === true
```

Check for `OracleSlashed` event logs:

```javascript
const filter = registry.filters.OracleSlashed(operator3Address);
const events = await registry.queryFilter(filter);
// events[0].args.amount === 0.01 ETH
// events[0].args.reason === "Score deviation too high"
```

### Step 5 — Request unstake for honest operators

```bash
# For each of operator-1 and operator-2:
node register_and_start.js --unstake
```

Operator 3's stake is partially slashed; the remaining 0.09 ETH can be unstaked after cooldown.

### Step 6 — Collect logs

```bash
docker compose --project-name canary-05 logs --tail=200 > docs/canary-05-logs.txt
```

---

## Expected Results

| Check | Expected |
|---|---|
| Campaign closes with median ~70 | Yes |
| Operator 3 publishes score 100 via VENOM_TEST_INJECT_SCORE | Yes |
| `DeviationReported` event emitted | Yes |
| `OracleSlashed` event emitted with operator 3 address | Yes |
| Slash amount = 10% of 0.10 = 0.01 ETH | Yes |
| Operator 3 deactivated (`active=false`) | Yes |
| `slashedStakeReserve` = 0.01 ETH | Yes |
| Honest operators (1, 2) remain active | Yes |

---

## Budget

| Item | Amount (ETH) |
|---|---|
| Operator stakes (3 × 0.10) | 0.30 |
| Campaign bounty | 0.005 |
| Gas (deploy + fund + close + unstake) | ~0.025 |
| **Total** | **~0.33** |
| Recoverable (3 × 0.10 - 0.01 slashed = 0.29) | 0.29 |

---

## Post-Canary

1. Recover stakes via `requestUnstake` → `finalizeUnstake` (7-day cooldown)
2. Verify `slashedStakeReserve` withdrawal path (owner-only, 48h timelock) — document but do not execute
3. Update `README.md` Canary History table
4. Write `docs/CANARY_05_RESULTS.md` as the canonical results record

---

## Risk

- **Budget shortfall:** If faucet accumulates <0.33 ETH before run day, reduce to 2 operators (0.22 ETH) with adjusted slashing scenario
- **Slashing misses:** If `MAX_DEVIATION=20` and injected deviation is only +20, deviation is *equal to* max and condition is `>` strict — use deviation=30 to guarantee
- **Operator 3 not deactivated after slash:** Contract code at `VenomRegistry.sol:198-201` explicitly deactivates — verify on-chain
