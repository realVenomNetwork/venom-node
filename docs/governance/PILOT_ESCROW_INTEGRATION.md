# PilotEscrow Governance Integration Plan

`ConsentManager` and `TitheManager` are compiled, tested, and deployable, but they are not yet part of the active `PilotEscrow.closeCampaign()` payment path.

## Target Flow

1. `PilotEscrow` closes a funded campaign after score and participation quorum succeeds.
2. The payment path determines the applicable consent owner, most likely the funder or an explicit campaign recipient added in a future campaign struct.
3. `ConsentManager.getEffectiveRate(user)` returns a basis-point rate and label.
4. The redirected amount is sent through `TitheManager.distribute()`.
5. `TitheManager` records claimable balances for charitable recipients and the campaign recipient.
6. Recipients call `claim()` or an operator calls `claimFor(recipient)` to pull funds.

## Required Contract Changes

- Add immutable or owner-set references to `ConsentManager` and `TitheManager`.
- Decide whether consent belongs to the funder, recipient, operator, or campaign-level config.
- Update events so off-chain indexers can distinguish gross bounty, redirected amount, and net recipient payment.
- Add tests for zero-consent, preset consent, custom consent, recipient fallback, and transfer failure behavior.
- Keep the pull-payment design: `PilotEscrow.closeCampaign()` must not be blocked by a charitable recipient contract that rejects ETH.

## Current Limitation

The active `PilotEscrow` still returns the campaign bounty to the recipient recorded at funding time. Operator bounty payouts and consent-based redirection are future work.
