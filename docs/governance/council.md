# VENOM Council — Worldview-Agnostic Governance Layer

**Parallel exploration repo** for pluralistic, rotating validator councils that work across Christian, Jewish, Muslim, secular, agnostic, and other worldviews.

**Goal**: Build technical primitives that allow different worldview branches to:
- Maintain internal trust rules (e.g. 2–3 mutual validators)
- Participate equally in a global inter-branch council
- Form "synthetic collaboration entities" where their top trusted nodes show strongest mutual agreement
- Keep the entire system **valid regardless of any specific worldview**

This module focuses on **tokenomics** (generalized tithing / charitable redirection) and **validation mechanics** (attestation-based trust + rotating councils). It is deliberately **faith-agnostic** and is now consolidated into the main `venom-network` project.

---

## Current Components (v0.2)

### 1. TitheManager.sol
Generalized redirection contract with built-in presets:
- `useChristianTithe()` → 10%
- `useZakat()` → 2.5%
- `useTzedakah()` → 10%
- `useSecular(customBps)`
- Fully custom rates + labeled presets

Can be called from `PilotEscrow.closeCampaign()` (or any future payment flow). Recipients and weighting are fully owner/governance controlled.

### 2. CouncilRegistry.sol
The core agnostic governance primitive:
- Registers worldview "branches" (`christian`, `jewish`, `muslim`, `secular`, `agnostic`, …)
- Each branch maintains its own validator list
- Trust earned via mutual attestations (generalized, not creed-specific) + merit metrics (evaluations, low slashing, stake, uptime — pulled from main `VenomRegistry`)
- Rotating "Top-N" council per branch (default 3)
- Global inter-branch council formed from top slices of each branch
- Now includes **`getBranchTopValidators()`** and **`getBranch()`** to support the Agreement Factory.

### 3. AgreementFactory.sol (NEW in v0.2)
Deploys **Synthetic Collaboration Entities** — lightweight multi-signature contracts — when two worldview branches show sufficient mutual attestation overlap among their top validators.

- Computes an “overlap score” (basis points) based on bidirectional attestations between validators of two branches.
- When overlap exceeds a configurable threshold (default 50%), deploys a `MinimalMultiSig` with the participating validators.
- Includes pause, ownership controls, rich events, and a fully open creation function (anyone can trigger).
- Worldview-agnostic: no internal creed logic; uses only universal attestation data.

### 4. MinimalMultiSig.sol (NEW in v0.2)
A simple k‑of‑m multi‑signature wallet template used by the Agreement Factory.

- Each deployed instance represents a concrete cross‑branch collaboration entity.
- Supports submission, confirmation, and execution with nonce‑based replay protection.
- Designed to be replaced later with a more audited multi‑sig pattern (e.g., Gnosis Safe proxy) when the network needs stronger security.

### Future Components (planned)
- `AgreementFactory.sol` extensions for custom Agreement contracts (creed‑conditional, timelock, grant‑specific).
- Integration helpers for `aggregator/p2p.js` and `eval_engine` (attestation publishing, council rotation signals).
- Dashboard widgets showing council composition, cross-branch agreement scores, and live multi‑sig activity.

---

## Design Principles (for long-term mergeability)

1. **Minimal & Focused** — Each contract does one thing well.
2. **Interface-first** — Easy to plug into existing `VenomRegistry` and `PilotEscrow` via simple references.
3. **Owner / Governance ready** — All sensitive functions are `onlyOwner`; can be handed to a timelock or DAO later.
4. **Event-rich** — Everything is indexable for off-chain dashboards and reputation oracles.
5. **Worldview-agnostic by default** — No hardcoded religious rules. Presets and branch names are just convenient labels.
6. **Merit + Representation balance** — Council composition can combine attestation trust, technical performance, stake weight, and (optional) demographic branch quotas.

---

## Active Structure

The governance contracts now live under `contracts/governance/` in this repository. Supporting scripts live under `scripts/governance/`, and notes live under `docs/governance/`.

---

## Integration Path

The governance contracts are compiled with the main Hardhat project, but the active escrow payment path does not yet call `TitheManager` or `ConsentManager`. The remaining integration work is:

- Add `TitheManager` reference + one-line change in `PilotEscrow.closeCampaign()`
- Add `CouncilRegistry` reference + optional `isActiveOracle` enhancement in `VenomRegistry`
- Add attestation publishing functions in `aggregator/p2p.js`

All existing testnet flows continue to work unchanged.

---

## Current Status (April 2026)

- **v0.2 Complete** — All core contracts implemented and reviewed.
- TitheManager with presets: ✅
- CouncilRegistry with top-validator support: ✅
- AgreementFactory (v0.2): ✅
- MinimalMultiSig (v0.2): ✅
- Next recommended step: Demo deployment script

---

**License**: MIT
**Maintained by**: realVenomNetwork (technical contributions welcome from any worldview)

---

*“The structure must remain valid regardless of worldview.”*

This repo exists to explore exactly that. Contributions that strengthen the technical primitives while preserving pluralism are highly valued.
