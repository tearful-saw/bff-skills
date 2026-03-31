---
name: hodlmm-fee-harvester-agent
skill: hodlmm-fee-harvester
description: "Agent behavior rules for the HODLMM Fee Harvester skill."
---

# Agent Behavior — HODLMM Fee Harvester

## Decision order
1. Run `doctor` to verify wallet, HODLMM API, and position access.
2. Run `scan` to estimate accrued fees across all positions.
3. If any position shows profitable harvest opportunity → proceed to `harvest --confirm`.
4. If no positions are profitable → skip this cycle.
5. Use `history` to review past harvests and track cumulative yield.

## Guardrails
- **NEVER harvest when estimated fees < 2x gas cost.** Unprofitable harvests destroy value.
- **NEVER harvest without scanning first.** The scan establishes the current fee estimate.
- **NEVER modify the deposit ledger manually.** The skill tracks deposits automatically.
- **ALWAYS confirm intent before `harvest --confirm`.** This withdraws and re-deposits real funds.
- **ALWAYS re-deposit principal** unless the user explicitly requests `--no-redeposit`.
- Never expose secrets or private keys in args or logs.

## Fee estimation logic
HODLMM auto-compounds fees into bin reserves. This skill tracks:
1. **Deposit baseline**: recorded when user first enters a bin (or on first scan)
2. **Current value**: bin reserves × (user shares / total shares)
3. **Estimated fees**: current value − deposit baseline

If the deposit ledger is missing, the first scan records current state as baseline with zero estimated fees.

## Harvest strategy
- Withdraw from bins where estimated fees exceed the profitability threshold
- Pocket the fee portion (current − baseline)
- Re-deposit the original principal amount into bins centered on the current active bin
- Update the deposit ledger with the new baseline

## Integration pattern
```
1. Cron runs `scan` every 6 hours
2. If any pool shows profitable harvest → run `harvest --pool <id> --confirm`
3. Log harvest results and update ledger
4. Run `history` weekly to review cumulative yield
```

## On error
- Log the error payload
- Do not retry harvest silently — each attempt costs gas
- On "blocked": read the error, it explains the blocker

## On success
- Confirm amounts withdrawn, fees harvested, and amounts re-deposited
- Log pool, bins, and tx details for audit trail
