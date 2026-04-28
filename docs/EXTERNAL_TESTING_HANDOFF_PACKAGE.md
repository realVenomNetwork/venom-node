# VENOM Node UX Layer v1.6 — External Testing Handoff

## 1. Quick Start for Testers

```bash
git clone <repo>
cd venom-node
npm install

npm run venom -- init          # creates .env + Operator Card
npm run doctor
npm run roadmap:check

docker compose up -d --build
# Dashboard: http://127.0.0.1:8787
```

**Wallet hygiene reminder**  
Use a fresh, low-balance Base Sepolia wallet. Never use a primary or cold-storage key.

---

## 2. Key Things to Test

**A. First-10-minute flow**  
`init` → `doctor` → `status --explain` → `card`

**B. Guardrails**  
`roadmap:check` + intentional writable Redis test (dashboard should refuse to start)

**C. Campaign Postcard v1**  
Manual: `venom postcard <uid> --tx <hash>`  
Automatic: after this node successfully closes a campaign

**D. Dashboard**  
Heartbeat, Lanterns, Quorum Replay (must feel like local reconstruction, not global transcript)

**E. Safety language review**  
Report any wording that implies more certainty than the system has (e.g. “verified globally”, “payout proven”, “operator ranking”).

---

## 3. Known Limitations (v1.6)

- Operator payouts not yet implemented
- Governance modules (ConsentManager, TitheManager) not yet wired into escrow payments
- Unstaking flow not yet implemented
- Real payload fetching still in progress (test payload mode remains the primary supported path)

---

## 4. Feedback Prompts for Testers

Please report on:

- First 10-minute experience
- Clarity of trust boundaries (“local observation” vs “on-chain state”)
- Dashboard usefulness and calm
- Postcard readability and honesty
- Any “what would surprise us” moments (anything that made you think the network does more than it actually does)
- Guardrail behavior under misconfiguration

**Where to send feedback**  
Please open a GitHub Issue with the label `ux-v1.6-feedback` or reply in the designated testing channel.

---

## 5. Suggested Tester Report Template

```markdown
# VENOM Node UX Layer v1.6 Tester Report

**Environment**
- OS / Node / Docker version
- Runtime mode + USE_TEST_PAYLOAD

**First 10 minutes**
What worked / was confusing / suggested improvement

**CLI** (doctor / init / status / card / postcard)

**Dashboard** (Heartbeat / Lanterns / Quorum Replay / Stability)

**Campaign Postcard v1** (Readability / Trust boundaries / Economic disclosure)

**Guardrails** (roadmap:check / Redis ACL / Runtime refusal)

**Known limitations acceptance**

**Bugs / Screenshots / Logs**