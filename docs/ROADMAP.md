# VENOM Network — Roadmap

**Last updated:** 2026-05-05

---

## Current Status

This project is in pre-testnet release candidate state. Core features implemented include:

- **Campaign funding and quorum-gated close** — `PilotEscrow` with EIP-712 score/abstain signatures, participation floor, and timeout refunds.
- **Oracle registry** — `VenomRegistry` with stake management, unstake cooldown (7 days), deviation-based slashing, and slashed stake reserve.
- **Leader election** — Signer-set-derived deterministic leader selection (replaced earlier UID-modulo approach).
- **Real payload fetching** — IPFS content hash wiring in `fundCampaign()` is implemented and end-to-end tested.
- **ML scoring service** — FastAPI microservice with `all-MiniLM-L6-v2` embedding model.
- **Operator UX** — CLI suite, Operator Cards, Campaign Postcards, Oracle Hearth dashboard, Redis read-only ACL sentinel.
- **Governance contracts** — `CouncilRegistry`, `AgreementFactory`, `MinimalMultiSig`, `ConsentManager`, `TitheManager` are compiled and tested but not yet wired into the active escrow payment path.

## Timeline

- **Q2 2026** — Pilot real payload fetching on Base Sepolia testnet; exercise slashing surface end-to-end
- **Q3 2026** — External security audit outreach; leader election hardening
- **Beyond** — Multi-model support, operator incentives, governance activation. See `docs/IMPROVEMENT_BACKLOG.md` for the working list.

---

**See `docs/IMPROVEMENT_BACKLOG.md` for the active working list of open items.**
