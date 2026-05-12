# Canary 03 Results

**Status:** template only. Do not mark Canary 03 complete until live deployment artifacts, generated-operator evidence, smoke-test reports, transaction hashes, and post-run notes are captured.

**Network:** Base Sepolia
**Chain ID:** `84532`
**Run date/time:** `TBD`
**Freeze commit SHA:** `TBD`

---

## 1. Local Freeze Results

Run from the repository root before deployment, operator generation, or live campaign funding.

```bash
npm ci
npm run compile
npm run lint:js
npm test
npm run test:pilot
npm run test:cist
npm run roadmap:check
git diff --check
git rev-parse HEAD
```

| Command | Result | Evidence / notes |
|---|---|---|
| `npm ci` | `TBD` | `TBD` |
| `npm run compile` | `TBD` | `TBD` |
| `npm run lint:js` | `TBD` | `TBD` |
| `npm test` | `TBD` | `TBD` |
| `npm run test:pilot` | `TBD` | `TBD` |
| `npm run test:cist` | `TBD` | `TBD` |
| `npm run roadmap:check` | `TBD` | `TBD` |
| `git diff --check` | `TBD` | `TBD` |
| `git rev-parse HEAD` | `TBD` | `TBD` |

Freeze notes:

```text
TBD
```

---

## 2. Canary 03 Evidence Gate

```bash
npm run pilot:canary03-gate -- --deployment=deployments/base-sepolia.json --canary-envs=.venom-canary-03
```

| Check | Result | Evidence / notes |
|---|---|---|
| Evidence gate command completed | `TBD` | `TBD` |
| Deployment artifact accepted | `TBD` | `TBD` |
| Operator env audit accepted | `TBD` | `TBD` |
| Secret/artifact hygiene accepted | `TBD` | `TBD` |
| Readiness checks accepted | `TBD` | `TBD` |

Gate output summary:

```text
TBD
```

---

## 3. Deployment Artifact Summary

Artifact path: `deployments/base-sepolia.json`

| Field | Value |
|---|---|
| `schemaVersion` | `TBD` |
| `network` | `TBD` |
| `chainId` | `TBD` |
| `profile.name` | `TBD` |
| `REQUIRED_ORACLES` | `TBD` |
| `SCORE_QUORUM_PCT` | `TBD` |
| `PARTICIPATION_FLOOR_PCT` | `TBD` |
| `CAMPAIGN_TIMEOUT_BLOCKS` | `TBD` |
| `MIN_STAKE` | `TBD` |
| `SLASH_PERCENT` | `TBD` |
| `MAX_DEVIATION` | `TBD` |
| `VenomRegistry` | `TBD` |
| `PilotEscrow` | `TBD` |
| `binding.registryPilotEscrow` | `TBD` |
| `binding.pendingPilotEscrow` | `TBD` |
| Deploy transaction hash(es) | `TBD` |
| Bind transaction hash | `TBD` |
| Verification status | `TBD` |

Do not paste private keys, mnemonics, deployer secrets, RPC URLs, or full local env files.

---

## 4. Operator Count And Funding Summary

| Item | Value |
|---|---|
| Generated operator count | `TBD` |
| Registered active oracle count | `TBD` |
| Funding target per operator | `TBD` |
| Total operator funding | `TBD` |
| Campaign bounty budget | `TBD` |
| Deployer/admin gas buffer | `TBD` |

Operator public addresses may be listed only if intentionally public for this run. Never list private keys.

| Operator | Public address | Funded amount | Registered? | Health port | Queue suffix | Peer ID captured? |
|---|---|---:|---|---:|---|---|
| 1 | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` |
| 2 | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` |
| 3 | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` |
| 4 | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` |
| 5 | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` |

---

## 5. Fixture Smoke-Test Matrix

| Scenario | Command | Result | Report path |
|---|---|---|---|
| all-agree | `npm run pilot:smoke-test -- --with-fixture-clients --strict` | `TBD` | `TBD` |
| mixed | `npm run pilot:smoke-test -- --scenario=mixed --with-fixture-clients --strict` | `TBD` | `TBD` |
| with-abstain | `npm run pilot:smoke-test -- --scenario=with-abstain --with-fixture-clients --strict` | `TBD` | `TBD` |

Redaction and report-teardown notes:

```text
TBD
```

---

## 6. Live Preflight And Health Snapshots

| Check | Result | Evidence / notes |
|---|---|---|
| `npm run pilot:preflight -- --network=base-sepolia` | `TBD` | `TBD` |
| Operator 1 `/healthz` | `TBD` | `TBD` |
| Operator 2 `/healthz` | `TBD` | `TBD` |
| Operator 3 `/healthz` | `TBD` | `TBD` |
| Operator 4 `/healthz` | `TBD` | `TBD` |
| Operator 5 `/healthz` | `TBD` | `TBD` |

Health snapshot notes:

```text
TBD
```

---

## 7. Live Scenario Matrix

| Scenario | Result | Campaign UID | Fund tx | Close/cancel tx | Smoke-test report path |
|---|---|---|---|---|---|
| all-agree | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` |
| mixed | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` |
| with-abstain | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` |

Notes:

```text
TBD
```

---

## 8. Manual Edge Checks

| Edge check | Performed? | Expected behavior | Observed behavior | Evidence |
|---|---|---|---|---|
| Hash mismatch | `TBD` | Abstain or fail-closed refusal; no poisoned success path | `TBD` | `TBD` |
| ML failure | `TBD` | Abstain or fail-closed refusal | `TBD` | `TBD` |
| Leader failover | `TBD` | Later eligible leader submits aggregate | `TBD` | `TBD` |
| Slashing path | `TBD` | Only if explicitly planned; behavior must match contract tests | `TBD` | `TBD` |

If slashing is not performed, state that explicitly rather than implying it was validated.

---

## 9. Transaction Hashes

| Purpose | Hash | Notes |
|---|---|---|
| Deploy registry | `TBD` | `TBD` |
| Deploy escrow | `TBD` | `TBD` |
| Bind registry to escrow | `TBD` | `TBD` |
| Operator registration 1 | `TBD` | `TBD` |
| Operator registration 2 | `TBD` | `TBD` |
| Operator registration 3 | `TBD` | `TBD` |
| Operator registration 4 | `TBD` | `TBD` |
| Operator registration 5 | `TBD` | `TBD` |
| Campaign funding | `TBD` | `TBD` |
| Campaign close/cancel | `TBD` | `TBD` |

---

## 10. Anomalies And Follow-Up Issues

| ID | Severity | Description | Follow-up issue / PR | Status |
|---|---|---|---|---|
| `C03-ANOM-001` | `TBD` | `TBD` | `TBD` | `TBD` |

Operational notes:

```text
TBD
```

---

## 11. Secret And Artifact Hygiene Confirmation

Confirm before committing this document.

| Check | Result | Notes |
|---|---|---|
| Generated operator `.env` files were not committed | `TBD` | `TBD` |
| Private keys and mnemonics were not pasted into docs, logs, or issues | `TBD` | `TBD` |
| Generated compose file was not committed unless intentionally sanitized | `TBD` | `TBD` |
| Deployment artifact does not contain secrets | `TBD` | `TBD` |
| `git diff --check` reviewed after result capture | `TBD` | `TBD` |
| Smoke-test reports archived or referenced without secrets | `TBD` | `TBD` |

Final result statement:

```text
TBD. Do not write "Canary 03 complete" until all required live evidence is present.
```

---

## 12. Deferred Outside Canary 03

These are explicitly outside this run and should not be described as validated by Canary 03:

- Governance payment integration.
- Operator payout semantics.
- External security audit.
- Prometheus-grade monitoring and production log aggregation.
