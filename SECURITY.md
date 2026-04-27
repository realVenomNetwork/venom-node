# Security Policy

VENOM Network contracts are unaudited and testnet-only.

## Reporting

Report suspected vulnerabilities privately through GitHub Security Advisories if enabled for the repository. If advisories are unavailable, contact the maintainers privately before publishing details.

Please include:

- Affected contract, script, or service.
- Reproduction steps.
- Impact and affected funds or keys, if any.
- Suggested remediation, if known.

Do not include private keys, seed phrases, or mainnet credentials in reports.

## Scope

In scope:

- Solidity contract vulnerabilities.
- Signature verification and aggregation bugs.
- Docker/runtime configuration that could expose keys or unauthenticated services.

Out of scope:

- Mainnet fund loss claims. This repository is not approved for mainnet deployment.
- Vulnerabilities caused by leaked local `.env` files or reused operator wallets.
