# Contributing

The maintainer is actively developing this project. External contributions, issues, and forks are welcome.

This repository contains Solidity contracts (Hardhat), a Node.js oracle runtime, a Python FastAPI ML scoring service, and evaluation tooling. Keep changes scoped and include verification steps in pull requests.

## Development Setup

```bash
git clone <repo-url>
cd venom-node
npm ci
cp .env.example .env
npm run compile
npm test
```

For the full local stack (fixture mode):

```bash
docker compose up -d --build
npm run pilot:smoke-test -- --scenario=all-agree
```

## Before Submitting a PR

```bash
npm test
npm run lint:js
npm run roadmap:check
```

## Guidelines

- **Contracts**: PRs touching consensus logic, slashing, quorum gates, or `PilotEscrow`/`VenomRegistry` must include regression tests in `test/`.
- **Do not commit**: `.env`, private keys, generated artifacts, caches, or local model output.
- **Code style**: Run `npm run lint:js` before pushing. Follow existing patterns in the affected file.
- **Governance**: Changes to `contracts/governance/` should be accompanied by test coverage and a note on integration impact.
- **Branching**: No strict naming convention. Use descriptive branch names.
- **PRs**: Include a summary of what changed, why, and what tests cover the change. For consensus changes, note any edge cases you considered.

## Known Areas for Contribution

See `docs/IMPROVEMENT_BACKLOG.md` for the working list of open items. The `README.md` "Known Limitations" section also calls out current gaps.
