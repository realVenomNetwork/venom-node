# Canary 01.5 - Reduced-Economic Multi-Operator Canary

**Status:** proposed next canary.
**Purpose:** validate multi-operator behavior before locking 5 ETH testnet stake.
**Disclosure:** this is not production-equivalent. It uses reduced stake and adjusted quorum constants so the run can stay near 1 total testnet ETH.

## Why This Exists

Canary 01 proved the solo close loop against real Base Sepolia infrastructure. It deliberately did not prove the distributed paths:

- multi-signer EIP-712 aggregation
- real peer-to-peer gossip propagation
- non-trivial median calculation
- leader failover between operators
- mixed score/abstain participation
- escrow-triggered deviation slashing

Canary 02 should eventually use production economics: 5 wallets with 1 ETH stake each. Canary 01.5 exists to de-risk that run with lower testnet ETH exposure.

## Recommended Profile

| Parameter | Value |
|---|---:|
| Chain | Base Sepolia |
| Operators | 5 fresh hot wallets |
| Stake per operator | 0.1 ETH |
| Total stake locked | 0.5 ETH |
| Suggested wallet balance | 0.16-0.20 ETH each |
| `REQUIRED_ORACLES` | 3 |
| `SCORE_QUORUM_PCT` | 50 |
| `PARTICIPATION_FLOOR_PCT` | 67 |
| `CAMPAIGN_TIMEOUT_BLOCKS` | 3600 for iteration, or 7200 for closer production soak |
| ML path | real evaluator, no force-pass |
| Payload path | real CID plus hash verification |

Expected total capacity: about 0.8-1.0 testnet ETH, including locked stake, deployment gas, close/cancel gas, and small campaign bounties.

Deploy the contracts with `DEPLOY_PROFILE=canary-01-5` so `MIN_STAKE`, `REQUIRED_ORACLES`, and timeout constants match this table. The production profile remains the default when `DEPLOY_PROFILE` is unset or set to `production`.

## Non-Negotiable Setup Rules

- Use fresh hot wallets only. Do not use a deployer, holding, or cold wallet key.
- `DEPLOYER_PRIVATE_KEY` must not be present in operator runtimes.
- `USE_TEST_PAYLOAD=false`.
- `ML_SERVICE_API_KEY` must be a real non-sentinel secret.
- Run live preflight with `PREFLIGHT_IPFS_CID` and `PREFLIGHT_IPFS_SHA256` set.
- Run `npm run pilot:preflight -- --network=base-sepolia --canary-envs=.venom-canary` before funding campaign bounties. Phase 7 is skipped automatically in multi-operator mode and Phase 9 owns canary readiness.
- Require public P2P dial-back unless the run is explicitly local-only.
- Preserve all deployment artifacts, logs, postcards, and dashboard snapshots.

## Operator Env Generation

After deploying with `DEPLOY_PROFILE=canary-01-5`, generate isolated local operator environments from the deployment artifact:

```bash
npm run pilot:operator-envs -- --count=5 --deployment=deployments/base-sepolia.json --out=.venom-canary --profile=canary-01-5
```

This writes `.venom-canary/operator-*/.env`, `.venom-canary/manifest.json`, `.venom-canary/funding-targets.txt`, and `docker-compose.canary-01-5.yml`. The `.venom-canary/` directory contains private keys and is ignored by git.

Use `funding-targets.txt` to fund the five generated hot wallets. Then run the generated compose file with a separate project name so it does not collide with the single-node dev stack:

```bash
docker compose --project-name canary -f docker-compose.canary-01-5.yml up -d --build
```

Before funding campaign bounties, run live preflight against the generated manifest:

```bash
npm run pilot:preflight -- --network=base-sepolia --canary-envs=.venom-canary
```

For a local-only rehearsal that intentionally uses private multiaddrs, add `--local-only`. Canary preflight checks generated operator balances, deployment/profile constants, queue suffix uniqueness, deployer/operator address separation, and private-multiaddr exposure.

## Queue Isolation

Do not run five local operator processes against one shared BullMQ queue name without per-operator isolation. With one shared queue, only one worker may receive a campaign job, which means only one operator signs.

For a local multi-operator canary on one Redis instance, use the same `QUEUE_NAME` and set a unique `OPERATOR_QUEUE_SUFFIX` in each operator environment:

| Operator | `QUEUE_NAME` | `OPERATOR_QUEUE_SUFFIX` |
|---|---|---|
| op1 | `venom-campaigns` | `op1` |
| op2 | `venom-campaigns` | `op2` |
| op3 | `venom-campaigns` | `op3` |
| op4 | `venom-campaigns` | `op4` |
| op5 | `venom-campaigns` | `op5` |

The suffix creates a distinct BullMQ queue and scopes the producer cursor plus queued-campaign marker for that operator. Isolated Redis databases or instances are still acceptable, but the suffix is the lowest-friction setup for Canary 01.5.

## Scenario Matrix

Run 6-10 small campaigns:

| Scenario | Expected Result |
|---|---|
| All 5 score | Clean close; on-chain median matches submitted scores. |
| 3 score, 2 abstain | Clean close under `REQUIRED_ORACLES=3`; participation passes. |
| 2 score, 3 abstain | Close must fail below absolute score floor. |
| One score outlier beyond `MAX_DEVIATION` | Campaign closes and deviant oracle is slashed. |
| Hash mismatch | Workers publish signed `HashMismatch` abstains; no invalid score is signed. |
| Round-0 leader stopped | A later leader submits after `P2P_LEADER_TIMEOUT_MS`. |

## Success Criteria

- At least 5 successful closes.
- At least one observed leader failover.
- At least one escrow-triggered `OracleSlashed` event.
- Dashboard/Quorum Replay shows multiple observed signers.
- Campaign Postcards are written for successful closes.
- Cost accounting separates spent gas, cancelled-campaign fees, locked stake, and stake recoverable after cooldown.

## Documentation Note

Real payload fetching and hash verification are implemented and solo-canary proven, including an observed `HashMismatch` abstain in Canary 01. They are not yet proven under a multi-operator canary.
