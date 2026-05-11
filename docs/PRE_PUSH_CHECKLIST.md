# Pre-Push Checklist

Use this before publishing the pre-canary-3 repository state. The checklist covers repository hygiene, not the live Canary 03 run itself.

## Required Checks

- [x] Remove temporary scratch files from the repository root.
- [x] Run focused outbox/RPC tests after the final integration pass.
- [x] Run JavaScript syntax lint.
- [x] Run the Hardhat test suite.
- [x] Run pilot tests.
- [x] Run CIST tests.
- [x] Run roadmap checks.
- [x] Run `git diff --check`.
- [x] Run a secret-pattern scan excluding generated reports and fixture test data.
- [ ] Review the full diff for accidental generated artifacts or private material.
- [ ] Stage intentional modified and new files.
- [ ] Commit the pre-canary-3 state.
- [ ] Push to GitHub.

## Commands

```bash
npm run lint:js
npm test
npm run test:pilot
npm run test:cist
npm run roadmap:check
git diff --check
```

Secret-pattern scan:

```bash
rg -n "0x[0-9a-fA-F]{64}|AKIA[0-9A-Z]{16}|Bearer [A-Za-z0-9._-]+" -g "!node_modules" -g "!test/**" -g "!scripts/pilot/**/__tests__/**" -g "!scripts/pilot/cist/__tests__/**" -g "!reports/**" .
```

## Do Not Commit

- `.env`
- `.venom-canary*/`
- generated operator `.env` files
- generated operator private keys
- live RPC keys or API tokens
- generated one-off compose files that include live operator env paths unless intentionally published as sanitized examples

## Live Canary 03 Still Requires

- Base Sepolia deployment with `DEPLOY_PROFILE=canary-03`.
- Generated operator envs and funding targets from the live deployment artifact.
- Operator address funding and registration.
- Public multiaddr reachability or documented dial-back warnings.
- Live smoke-test reports for all-agree, mixed, and with-abstain scenarios.
