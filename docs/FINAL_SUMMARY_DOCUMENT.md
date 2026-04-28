# VENOM Node UX Layer v1.6 — What We Built

## Executive Summary

Over the Tier 1 → Tier 2 → Tier 3 design cycle and subsequent Codex implementation rounds, VENOM Node gained a complete operator-facing UX layer that reframes the project from raw oracle infrastructure into a careful, bounded, testnet-ready “living oracle guild” experience.

The v1.6 UX layer does three things at once:

1. It improves the first-10-minute operator experience.
2. It makes node activity visible through local dashboards, field notes, and replay artifacts.
3. It preserves strict epistemic boundaries between **local observation**, **on-chain state**, **hypothetical simulation**, and unfinished economic/governance mechanisms.

The implementation is anchored by runtime-mode guardrails, a canonical vocabulary, a CLI suite, local Operator Cards, Campaign Postcards v1, Oracle Hearth dashboard infrastructure, Redis read-only dashboard isolation, and `roadmap:check` enforcement.

---

## Phase 1 — Guardrails & Operator Confidence

**Runtime mode guardrails**  
Explicit `VENOM_RUNTIME_MODE` + `USE_TEST_PAYLOAD` validation with startup refusal for invalid combinations (e.g. `mainnet` + test payload). Artifact directories are derived by mode, creating a clear trust boundary for all operator-facing artifacts.

**Mechanically enforced roadmap checks**  
`roadmap:check` now enforces vocabulary presence, runtime-mode matrix, Redis ACL sentinel behavior, the locked README-only product phrase rule, postcard immutability, `submitter` field, on-chain close marker, `schema_version: "postcard.v1"`, and `scope: "local_observation"`.

**Canonical vocabulary**  
Versioned `vocabulary/vocabulary.json` with terms such as Local Observation, On-chain State, Hypothetical Simulation, Runtime Mode, and Test Payload, each assigned explicit trust boundaries (`node-local`, `chain-derived`, `simulation`, `configuration`).

**CLI suite**  
```bash
venom init
venom doctor
venom status
venom card
venom postcard
```
All commands support `--explain`.

**Local-only Operator Card**  
Regenerable setup artifact at `~/.venom/operator-card.md` with the exact disclaimer:  
> “This is a local operator setup card. It records configuration, not reputation.”

**Dashboard Redis read-only sentinel**  
Dashboard refuses to start if its Redis connection is writable. Docker Compose provisions a `venom_dash` read-only Redis user and binds the dashboard to `127.0.0.1:8787`.

---

## Phase 2 Core — Living Guild Experience

**Campaign Postcard v1 — Local Field Notes**  
Immutable local field notes with `schema_version: "postcard.v1"`, `scope: "local_observation"`, `submitter`, judgment capsule, economic disclosure, and clear “What This Can Show / Cannot Prove” sections placed first. Markdown rendering includes ephemerality warning that the postcard is not a credential, ranking, governance approval, or portable reputation claim.

**Automatic postcard generation**  
The p2p close path now generates a Campaign Postcard v1 after observing a successful `closeCampaign` receipt and emits a dashboard event.

**Oracle Hearth dashboard**  
Separate localhost-only process with SSE updates, mode banners, heartbeat, Campaign Lanterns, and UI-only Quorum Replay. Subscribes to Redis dashboard events and broadcasts status every 10 seconds.

**Quorum Replay + Campaign Lanterns**  
UI-only 30–60s visual reconstruction from local Redis snapshots. Lantern states remain strictly node-local (Observed → Decided → Postcard ready → Logged → Stale) and never imply global finality.

---

## Key Design Principles Delivered

1. **Economics before reputation** — Phase 3+ gated on committed operator payment design.
2. **Epistemic clarity everywhere** — Local observation clearly separated from on-chain state and hypothetical simulation.
3. **Narrow v1 before richer v2** — Postcard v1 is intentionally conservative.
4. **Dashboard isolation is non-negotiable** — Separate process, localhost-only, Redis ACL read-only.
5. **Test payload boundaries are explicit** — Runtime-mode policy prevents test-mode artifacts from being mistaken for real judgment.

---

## Verification Status (Latest Local Run)

- `roadmap:check` — passing
- Hardhat tests — 42/42 passing
- `lint:js` — clean
- Full integration smoke-tested (Postcard generation, Quorum Replay, Lanterns, guardrails)
