# Improvement Backlog

This document consolidates the report items that were not fully taken in the current pass. It is intended as the working reference for future hardening iterations.

Source reports reviewed:

- `qwen.txt`
- `minimax.txt`
- `kimi.txt`
- `meta.txt`
- `mistral.txt`
- `ling-2.6-flash-free-report.md`
- `big-pickle-report.md`
- `nemotron-3-super-free-venom-node-report.md`
- `claude.txt`
- `gemini.txt`
- `grok.txt`
- `deepseek.txt`
- `grok2.txt`
- `gemini2.txt`
- `claude2.txt`
- `gemini3.txt`
- `claude3.txt`
- `claude4.txt`
- `gemini4.txt`
- `gemini5.txt`
- `claude5.txt`
- `claude-suggestion/PATCH_NOTES.md`
- `claude6.txt`
- `gemini6.txt`

## Applied In This Pass

- Added `ReentrancyGuard`, `Pausable`, strict OpenZeppelin `ECDSA` recovery, campaign UID validation, score range checks, and array caps to `PilotEscrow`.
- Cached `VenomRegistry.activeOracleCount()` and added `SlashSkipped` visibility for no-op deviation reports.
- Made failed `MinimalMultiSig` executions retryable.
- Allowed `ConsentManager.setPreset(NONE)` and guarded `TitheManager` claims with `nonReentrant`.
- Moved the test payload into `data/fixtures`, made `USE_TEST_PAYLOAD=false` the example default, and reject test-payload mode under `NODE_ENV=production`.
- Added worker ML timeout/error handling, streaming payload size enforcement, configurable worker concurrency, and signed abstains for missing payloads, fetch failures, ML failures, and below-threshold results.
- Fixed abstain gossip to publish numeric reason codes and made P2P verify typed-data signatures locally before queueing messages.
- Added a producer reorg lookback, cached RPC providers, Python request length caps, pinned Python dependency ranges, and focused tests for the new contract behavior.
- Added periodic active-oracle refresh in P2P so existing nodes accept newly registered operators without restart.
- Fixed `CouncilRegistry.removeValidatorFromBranch()` so removed validators leave the branch array.
- Added per-operator worker idempotency keys in Redis to avoid duplicate score/abstain publication during producer re-scans.
- Changed out-of-range ML scores from retrying poison jobs into signed `MLServiceFailed` abstains.
- Added byte-accurate UTF-8 request size validation to the ML service.
- Added `nonReentrant` to `MinimalMultiSig.executeTransaction()` and corrected the ECDSA malleability test to use high-`s` signatures.
- Bounded P2P pending-campaign memory with a TTL, periodic garbage collection, and a maximum pending-campaign cap.
- Returned generic ML service 500 responses while logging raw scoring errors server-side.
- Made the worker `MissingPayload` path return explicitly after publishing its signed abstain.
- Reordered P2P gossip handling so malformed signatures, invalid score/reason data, and inactive signers cannot allocate or refresh pending-campaign state.
- Configured ML service logging explicitly so sanitized HTTP 500 responses still leave server-side traceback details for operators.
- Replaced UID-modulo off-chain leader selection with signer-set-derived leader selection and timeout-based round rotation.
- Mirrored the escrow score quorum, score percentage, and participation floor gates off-chain before attempting aggregate submission.
- Hardened already-closed aggregate submission cleanup against common ethers error wrapping fields.

## Next Iteration Candidates

### Protocol And Contract Design

- Upgrade signer-set-derived off-chain leader selection to a full commit-reveal design, then VRF. The current bridge reduces funder predictability but is not a final unbiasable randomness scheme.
- Consider optional on-chain leader enforcement only if leader gas reimbursement or stronger submitter attribution becomes necessary.
- Implement real payload identity: campaign events need content metadata, and workers need CID/multihash verification before scoring. `HashMismatch` exists as a reason but is not yet produced.
- Address campaign UID squatting by deriving campaign IDs from funder, salt, and content hash or by adding a reservation/commit flow.
- Add oracle unstaking and deregistration with a cooldown, slash eligibility during cooldown, and clear operator exit docs.
- Add a slashing dispute window before slashes become withdrawable.
- Decide insurance pool governance: who can withdraw, under what policy, and with what timelock.
- Make protocol constants configurable within bounded ranges where testnet tuning is expected: minimum stake, slash percent, max deviation, quorum parameters, and timeout.
- Move governance owners to `Ownable2Step`, transfer ownership to a multisig, and add timelocks for rate, recipient, threshold, and registry changes.
- Gate `CouncilRegistry.attestTrust` and `CreedValidator.attestNode` by active-oracle status or stake weight to avoid permissionless sybil attestations.
- Wire `ConsentManager` and `TitheManager` into the escrow payment path only after the consent subject, rate source, event model, and pull-payment flow are specified.
- Add operator bounty payment semantics. The current `PilotEscrow` returns bounty to the funder-designated recipient.
- Consider custom errors for gas and richer revert context.
- Consider quickselect for median calculation if oracle set sizes grow materially.
- Decide whether `AgreementFactory` should use EIP-1167 clones from `agreementTemplate` or remove the unused template path.

### Runtime And Network

- Replace `mplex` with `yamux` after adding the dependency and testing libp2p compatibility.
- Periodically dial newly discovered oracle multiaddrs, not just refresh the accepted signer set.
- Add P2P/RPC rate limits and spam controls.
- Move env parsing into a single config module with validation and typed defaults.
- Split deployment and node operation key paths fully: keep `DEPLOYER_PRIVATE_KEY` deploy-only and require `OPERATOR_PRIVATE_KEY` for runtime after a migration window.
- Add encrypted keystore or hardware-wallet support before any production-style deployment.
- Make contract reads created from `MultiRpcProvider.getProvider()` fallback-aware. Current fallback covers direct provider calls better than long-lived `ethers.Contract` instances.
- Add BullMQ job timeout/backoff configuration that is explicitly larger than fetch plus ML timeout budgets.
- Consider racing a bounded number of IPFS gateways concurrently with aborts for slower requests. Keep sequential fallback only if bandwidth conservation is more important than latency.
- Add structured logging with a real logger and subsystem fields.
- Add Prometheus metrics for worker jobs, producer scans, gossip messages, RPC fallback, ML failures, and close submissions.
- Add a node application `/healthz` endpoint that checks queue connectivity and recent worker activity, then point Docker healthchecks at it.
- Build a real dashboard from metrics instead of random simulated data.

### ML Service

- Add authentication for `/evaluate` when deployed outside local-only Docker networking.
- Add rate limiting and structured error responses with retry hints.
- Pre-bake or cache the sentence-transformer model in the Docker image to avoid slow first boot.
- Unify duplicate scoring variants into one configurable scorer.
- Convert `eval_engine` into a package so `ml_service/main.py` does not need to mutate `sys.path`.

### Infra, CI, And Testing

- Add GitHub Actions for compile, Hardhat tests, JS lint, Python checks, and production audit checks.
- Add ESLint with security rules and Prettier or another formatter policy. The current JS check is syntax-only.
- Add Solhint and Slither.
- Add fuzz or invariant tests for score/abstain validation, duplicate handling, malformed signatures, and quorum edge cases.
- Add end-to-end tests covering event discovery, worker scoring/abstaining, gossip aggregation, and `closeCampaign`.
- Add worker-side tests for signed abstain reason wiring: `MissingPayload`, `MLServiceFailed`, `BelowThreshold`, and gateway fetch failures.
- Add Docker resource limits and revisit image layout with a multi-stage build.
- Add Redis auth/TLS guidance for non-local deployments.
- Add dependency scanning for npm and Python dependencies and document the current `npm audit` findings before upgrading.

### Documentation

- Make each README/guide section visibly distinguish shipped behavior from planned behavior.
- Expand operator troubleshooting for registration failures, stake balance, RPC connectivity, multiaddr issues, Redis connectivity, ML service health, and test-payload mode.
- Document failure modes for fetch, ML timeout, abstain publication, quorum failure, leader non-submission, slashing, cancellation, and reorg rescans.
- Add a contract operations checklist for pausing, unpausing, owner actions, treasury withdrawals, and incident response.
- Document migration strategy for replacing `PilotEscrow`, since `VenomRegistry.setPilotEscrow()` is currently one-time.
