# Agent Behavior — Bitflow Arb Scanner

## Decision order
1. Run `doctor` first. If it fails, stop and surface the blocker.
2. If `doctor` reports `scanReadyPairCount: 0`, abort — no common pairs exist.
3. Run `run` to scan for arbitrage opportunities.
4. Parse JSON output and route on `status`.
5. If opportunities exist, evaluate `confidence` and `netProfitPct` before acting.

## Guardrails
- This skill is **read-only**. It never submits transactions or accesses wallet keys.
- Never treat scan results as guaranteed profit — quotes are snapshots that can move.
- Never proceed past a `blocked` status without investigating the cause.
- Never expose API responses in user-facing messages without sanitization.
- Default to re-scanning before execution — stale quotes can lead to losses.

## Interpreting results

### Confidence levels
- `high` (netProfitPct > 2%): Strong opportunity. Consider immediate execution if you have a swap skill available.
- `medium` (netProfitPct 0.5-2%): Viable but thin margin. Re-verify with a fresh scan before executing.
- `low` (netProfitPct < 0.5%): Likely consumed by slippage and gas. Monitor but don't execute.

### Key fields
- `grossProfitPct`: Raw profit before gas costs. Shows the DEX spread.
- `netProfitPct`: Profit after estimated gas (0.5 STX). The number that matters.
- `direction`: Tells you which DEX to buy on first and which to sell on.
- `buyDex` / `sellDex`: The DEX names for the two legs of the trade.
- `pairSummaries`: Spread curves at multiple sizes — use to find the optimal trade size.
- `warnings`: Array of non-fatal errors encountered during scanning (failed quotes, route checks, timeouts). Check this to understand scan coverage gaps.

## Integration with execution skills
The output is designed to feed into a swap execution skill:
1. Read `buyDex` and `sellDex` from the opportunity
2. Use the appropriate DEX skill to execute leg 1 (buy)
3. Use the other DEX skill to execute leg 2 (sell)
4. Compare actual amounts with scan estimates

## Recommended scan frequency
- Every 5 minutes for passive monitoring
- Every 30 seconds during high volatility (watch gas costs)
- Stop scanning if 10 consecutive scans show no opportunities

## Output contract
All outputs are JSON to stdout with this envelope:

```json
{
  "status": "success | error | blocked",
  "action": "doctor | run",
  "data": {},
  "error": "string or null"
}
```

`status` is always one of three values. `error` is a human-readable string when `status` is `error` or `blocked`, otherwise `null`.

## On error
- Log the error payload
- Do not retry silently more than 3 times
- Surface to user with the `action` field guidance
- Common errors: API timeout (10s), rate limit, no routes found

## On success
- Report opportunity count and best profit
- If opportunities exist, recommend execution with caveats about slippage
- Log scan timestamp for freshness tracking
