---
name: hodlmm-il-tracker-agent
skill: hodlmm-il-tracker
description: "Agent behavior rules for the HODLMM IL Tracker — impermanent loss monitoring skill."
---

# Agent Behavior — HODLMM IL Tracker

## Decision order
1. Run `doctor` to verify wallet and HODLMM API access.
2. Run `snapshot` to establish entry baselines for any new positions.
3. Run `status` or `run` to get current IL readings.
4. Route on severity:
   - `healthy` (IL > -1%) → no action needed
   - `mild` (-5% < IL <= -1%) → monitor, check again next cycle
   - `severe` (IL <= -5%) → alert user, recommend recenter via `hodlmm-range-keeper`
5. Check `netPnlPercent` — if fees cover IL (net positive), position is still profitable despite IL.

## Guardrails
- **This skill is read-only.** It never writes to chain or moves funds.
- Never proceed past a `blocked` status without explicit user confirmation.
- Never expose secrets or private keys in args or logs.
- Always surface error payloads with a suggested next action.
- Default to safe/read-only behavior when intent is ambiguous.
- Do not auto-trigger recenters — only recommend. The user or `hodlmm-range-keeper` decides.

## Autonomous scheduling
```
1. Cron runs `run` every 15 minutes
2. Parse alerts array — if non-empty, surface to user
3. If IL severity is "severe" on any pool → recommend `hodlmm-range-keeper recenter`
4. Run `history --limit 10` daily to check IL trend direction
```

## IL severity classification
- **Healthy** (IL > -1%): Normal for concentrated liquidity. Position is earning well.
- **Mild** (-5% < IL <= -1%): IL is growing but may be offset by fees. Monitor.
- **Severe** (IL <= -5%): Significant value loss vs HODL. Consider recenter or exit.

## Net P&L interpretation
- `netPnlPercent > 0`: Fees exceed IL — position is profitable despite impermanent loss.
- `netPnlPercent < 0`: IL exceeds fees — position is losing value vs holding.
- `netPnlPercent < -3%`: Strongly consider exit or recenter.

## On error
- Log the error payload
- Do not retry silently
- Surface to user with the `action` field guidance

## On success
- Report IL summary with severity classification
- Surface any alerts for severe positions
- Recommend specific actions (hold / monitor / recenter)

## Integration with other skills
- **hodlmm-range-keeper**: When IL tracker shows `severe` + `consider_recenter`, feed this into range-keeper's decision. After a recenter, re-snapshot the position (`snapshot --pool <id> --force`).
- **hodlmm-liquidity-tide**: If tide is FALLING and IL is worsening, stronger signal to exit. If tide is RISING and IL is mild, fees may recover — hold.
- **hodlmm-fee-harvester**: Fee estimates overlap — use IL tracker for the net picture, fee-harvester for per-bin granularity. Avoid double-counting harvested fees.
