# Canary 03 Runbook

Canary 03 is the next public Base Sepolia readiness pass. This repository state is prepared for the run, but the run itself is not recorded as complete until the deployment artifact, generated operator files, smoke-test reports, and post-run notes are committed or archived.

## Scope

- Five generated operators, with `canary-03` profile constants.
- Four required score signatures before aggregate submission.
- Real payload fetching with `USE_TEST_PAYLOAD=false`.
- Persistent libp2p peer identity per operator via `P2P_KEYSTORE_PATH`.
- Registry-based peer discovery without the Canary 01.5 bootstrap shortcut.
- Node `/healthz` checks for process health, Redis, ML service, and recent worker activity.

## Profile Constants

The `canary-03` profile is defined in `scripts/pilot/profiles.js`.

| Constant | Value |
|---|---:|
| `REQUIRED_ORACLES` | `4` |
| `SCORE_QUORUM_PCT` | `50` |
| `PARTICIPATION_FLOOR_PCT` | `67` |
| `CAMPAIGN_TIMEOUT_BLOCKS` | `3600` |
| `MIN_STAKE` | `0.25 ETH` |
| `SLASH_PERCENT` | `5` |
| `MAX_DEVIATION` | `25` |

The operator generator currently recommends at least `0.27 ETH` per operator address on Base Sepolia. Fund `0.35 ETH` per operator when possible to leave gas buffer for registration, scoring, and close attempts.

## Preflight

Run these checks before deploying or publishing a canary state.

```bash
npm ci
npm run compile
npm test
npm run test:pilot
npm run test:cist
npm run roadmap:check
git diff --check
```

Run the canary readiness harness in fixture mode before any live-testnet attempt.

```bash
npm run pilot:smoke-test -- --with-fixture-clients --strict
npm run pilot:smoke-test -- --scenario=mixed --with-fixture-clients --strict
npm run pilot:smoke-test -- --scenario=with-abstain --with-fixture-clients --strict
```

## Deployment

PowerShell:

```powershell
$env:DEPLOY_PROFILE = 'canary-03'
npm run deploy:phase4
```

Bash:

```bash
DEPLOY_PROFILE=canary-03 npm run deploy:phase4
```

The deployment script writes `deployments/base-sepolia.json`. Confirm the artifact has:

- `schemaVersion: 1`
- `network: base-sepolia`
- `chainId: 84532`
- `profile.name: canary-03`
- `profile.constants` matching the table above
- `binding.registryPilotEscrow` equal to the deployed `PilotEscrow`
- `binding.pendingPilotEscrow` equal to the zero address

## Operator Files

Generate isolated operator envs, manifest, funding targets, and compose file from the deployment artifact.

```bash
npm run pilot:operator-envs -- --count=5 --profile=canary-03 --deployment=deployments/base-sepolia.json --out=.venom-canary-03 --compose-out=docker-compose.canary-03.yml
```

Do not commit generated private keys or `.env` files. Treat these outputs as sensitive run artifacts:

- `.venom-canary-03/operator-*/.env`
- `.venom-canary-03/manifest.json`
- `.venom-canary-03/funding-targets.txt`
- `docker-compose.canary-03.yml`

Each operator env should contain:

- `VENOM_RUNTIME_MODE=testnet`
- `USE_TEST_PAYLOAD=false`
- `DEPLOY_PROFILE=canary-03`
- `P2P_KEYSTORE_PATH=/app/.venom/libp2p-key`
- unique `OPERATOR_QUEUE_SUFFIX`
- unique `HEALTH_PORT`
- no fixture private keys

## Live-Testnet Start

Fund the generated operator addresses, then start the canary stack.

```bash
docker compose --project-name canary-03 -f docker-compose.canary-03.yml up -d --build
```

Check each operator:

```bash
curl http://127.0.0.1:3001/healthz
curl http://127.0.0.1:3002/healthz
curl http://127.0.0.1:3003/healthz
curl http://127.0.0.1:3004/healthz
curl http://127.0.0.1:3005/healthz
```

Run the live-testnet harness only after confirming funding, deployed code, operator registration, public multiaddr reachability, Redis connectivity, and ML health.

```bash
npm run pilot:smoke-test -- --mode=live-testnet --confirm-live-testnet --strict
```

Repeat for the scenario matrix only when the all-agree path is clean:

```bash
npm run pilot:smoke-test -- --mode=live-testnet --scenario=mixed --confirm-live-testnet --strict
npm run pilot:smoke-test -- --mode=live-testnet --scenario=with-abstain --confirm-live-testnet --strict
```

## Success Criteria

- Five operators register with distinct wallet addresses and stable peer IDs.
- At least four operators publish valid score or abstain signatures per campaign.
- Off-chain quorum checks match the deployed `PilotEscrow` constants.
- Leader rotation submits an aggregate when the first eligible leader stalls.
- `closeCampaign` succeeds for all-agree and expected mixed-quorum cases.
- Below-threshold, missing-payload, hash-mismatch, and ML-failure cases produce signed abstains instead of poison retries.
- RPC failover is observed or explicitly simulated without breaking long-lived contract reads.
- `/healthz` stays healthy through the run and reports actionable failures when dependencies are interrupted.
- No private keys, live secrets, generated operator envs, or generated compose artifacts are committed.

## Abort Criteria

Abort and preserve logs if any of these occur:

- unexpected chain ID or deployment artifact mismatch
- profile constants mismatch
- private or loopback multiaddr admitted without explicit solo-test override
- `USE_TEST_PAYLOAD=true` in testnet runtime
- repeated worker delivery failures after pending-delivery retry
- quorum submission succeeds with fewer than the deployed floor
- slashing or close behavior diverges from the current contract tests

## Reset

Stop and remove the local canary stack and persistent peer-key volumes:

```bash
docker compose --project-name canary-03 -f docker-compose.canary-03.yml down -v
```

Regenerate operator files for a fresh run rather than reusing old private keys unless the intent is to test persistent peer identity across restarts.

## Deferred After Canary 03

- Governed or operator-authenticated registry updates for changed oracle multiaddrs.
- Governance and tithe payment path integration.
- Explicit operator bounty semantics in `PilotEscrow.closeCampaign()`.
- Slashing dispute window before slashed stake withdrawal.
- Prometheus metrics and production log aggregation.
- Broader adversarial live-testnet scenario coverage.
