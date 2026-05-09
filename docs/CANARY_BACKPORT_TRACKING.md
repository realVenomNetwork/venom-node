# Canary Backport Tracking

This file records the Canary 01 issues referenced by `docs/CANARY_01_RESULTS.md`. It is intentionally concise; detailed reproduction notes should be appended as regressions are added.

## MAIN-FIX Summary

| ID | Severity | Component | Status | Regression Target |
|---|---|---|---|---|
| MAIN-FIX-1 | Medium | `aggregator/p2p.js` | Backported | gossipsub `emitSelf: true` for solo/self-observed signatures |
| MAIN-FIX-2 | High | `scripts/pilot/preflight.js` | Backported | `oracles(address)` ABI returns 6 fields |
| MAIN-FIX-3 | Low | `aggregator/p2p.js` | Backported | active-oracle refresh handles missing iterable values |
| MAIN-FIX-4 | Medium | `scripts/deploy_phase4.js` | Backported | public-network bind transaction waits 3 confirmations and readback retries |
| MAIN-FIX-5 | High | `Dockerfile`, `package.json`, CI | Backported | Node 22 runtime requirement |
| MAIN-FIX-6 | Medium | `aggregator/queue.js`, preflight, env | Backported | Redis username defaults to `venom_node` |
| MAIN-FIX-7 | Low | `register_and_start.js` | Backported | deployer key rejection gives remediation text |
| MAIN-FIX-8 | Low | `hardhat.config.js`, `.env.example` | Backported | Etherscan V2 single API key |
| MAIN-FIX-9 | Low | `register_and_start.js`, docs | Backported | explicit solo-only private multiaddr escape hatch |
| MAIN-FIX-10 | Medium | `ml_service/main.py`, `.env.example` | Backported | testnet/mainnet reject missing or sentinel ML API key |
| MAIN-FIX-11 | Low | `aggregator/p2p.js` | Backported | node does not continuously re-dial its own multiaddr |
| MAIN-FIX-12 | Low | `Dockerfile` | Backported | `/app/.venom-artifacts` exists and is writable by `node` |

## Next Regression Pass

When touching affected code, add focused tests tagged with comments such as:

```js
// Regression: MAIN-FIX-6
```

Prioritize MAIN-FIX-1, MAIN-FIX-2, MAIN-FIX-5, MAIN-FIX-6, MAIN-FIX-10, and MAIN-FIX-12 because these either blocked operators or only surfaced against real infrastructure.

## Canary-Only Changes

The Canary 01 checkout used relaxed constants and `CANARY_FORCE_PASS=true`. These were canary-only shortcuts and must not be treated as production defaults.
