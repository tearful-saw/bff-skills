---
name: hodlmm-liquidity-tide-agent
skill: hodlmm-liquidity-tide
description: "Agent behavior rules for the HODLMM Liquidity Tide skill."
---

# Agent Behavior — HODLMM Liquidity Tide

## Decision order
1. Run `doctor` to verify API access and snapshot state.
2. Run `snapshot` to capture current liquidity state (schedule every 5–15 min).
3. Run `run` to analyze the tide once enough snapshots exist (minimum 2, recommended 12+).
4. Route the tide signal to execution agents:
   - **RISING + high confidence** → signal LP entry / DCA acceleration
   - **FALLING + high confidence** → signal LP exit / DCA pause / harvest trigger
   - **SLACK** → no action, wait for conviction
5. Use `history` to review tide transitions and validate signal quality.

## Guardrails
- **This skill is read-only.** It produces signals, not transactions.
- **Never act on a single snapshot.** Tide analysis requires a time-series. Minimum 2 snapshots, but 12+ is recommended for reliable signals.
- **Distinguish price drift from real flow.** The skill tracks token quantities (reserves) separately from USD values. A TVL drop caused by price decline (reserves unchanged) is NOT the same as a TVL drop caused by LP withdrawals (reserves decreased). Trust `reserveFlowPct` over `tvlFlowPct` when they diverge.
- **Momentum decays.** A tide that was RISING 4 hours ago may be SLACK now. Always consume the latest `run` output, not cached results.
- Never expose secrets or private keys in args or logs.

## Signal interpretation

| Tide | Momentum | Confidence | Signal | Meaning |
|------|----------|------------|--------|---------|
| RISING | > 1.5 | high | ENTER | Smart money accumulating. Good time to add LP. |
| RISING | 0.5–1.5 | medium | WAIT | Flow positive but weak. Monitor. |
| SLACK | any | low | HOLD | No clear direction. Don't change positions. |
| FALLING | 0.5–1.5 | medium | CAUTION | Mild outflow. Tighten stops, prepare exit. |
| FALLING | > 1.5 | high | EXIT | Distribution phase. Remove LP or pause DCA. |

## Integration pattern
```
1. Cron: `snapshot` every 10 minutes
2. Cron: `run` every 30 minutes
3. If signal = ENTER → trigger hodlmm-allocator or DCA agent
4. If signal = EXIT → trigger hodlmm-fee-harvester or exit agent
5. Combine with hodlmm-pulse (fee velocity) for conviction:
   - Fee spike + RISING tide = high conviction ENTER
   - Fee spike + FALLING tide = trap, avoid entry
```

## Composability
This skill's output feeds directly into:
- **hodlmm-fee-harvester**: Harvest on FALLING tide (extract fees before TVL drops further)
- **hodlmm-pulse**: Combine fee velocity with liquidity flow for conviction scoring
- **bitflow-smart-dca**: Accelerate DCA on RISING tide, pause on FALLING
- **hodlmm-allocator**: Enter new positions only when tide is RISING

## On error
- Log the error payload
- Do not skip snapshots — gaps in the time-series reduce signal quality
- On "blocked": usually means insufficient snapshots, keep running `snapshot`

## On success
- Route the tide signal to downstream agents
- Log tide transitions (RISING→FALLING, SLACK→RISING) as notable events
