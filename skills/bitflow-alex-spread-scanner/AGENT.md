# Agent Behavior — Bitflow ↔ Alex Spread Scanner

## Decision order
1. Run `doctor` first. If it emits warnings about `HIRO_API_KEY`, consider setting that env var before `run` on large pair sets.
2. If `doctor` reports `scanReadyPairCount: 0`, abort — no common pairs exist.
3. Run `run` to scan for opportunities.
4. Parse JSON output and route on `status`:
   - `success`: scan fully completed, `opportunities` and `pairSummaries` are trustworthy.
   - `degraded`: more than 20% of quote attempts failed. `opportunities` may be incomplete; consult `warnings` and `scanStats.failureRate` before acting.
   - `blocked`: no common pairs — nothing to do.
   - `error`: unrecoverable; log `error` message and escalate.
5. If opportunities exist and status is not `degraded`, evaluate `confidence` and `netProfitPct` before acting.

## Guardrails
- This skill is **read-only**. It never submits transactions or accesses wallet keys.
- Never treat scan results as guaranteed profit — quotes are snapshots that can move.
- Never act on a `degraded` result without re-running with `HIRO_API_KEY` set or widening the re-verify step.
- Never expose full API responses in user-facing messages without sanitization.
- Default to re-scanning right before execution — stale quotes can lead to losses.

## Interpreting results

### Confidence levels (bucketing of `netProfitPct`)
- `high` (netProfitPct > 2%): strong opportunity. Consider execution if a swap skill is available.
- `medium` (0.5% < netProfitPct ≤ 2%): viable but thin margin. Re-verify with a fresh scan before executing.
- `low` (0% < netProfitPct ≤ 0.5%): surface-level positive but marginal. Monitor; don't execute without re-verification.

Note: opportunities with `netProfitPct ≤ minProfitPct` (default 0.1%) are filtered out entirely and do not appear in `opportunities[]` — they still appear in `pairSummaries[]` for diagnostic visibility.

### Key fields

**On each opportunity:**
- `grossProfitPct`: raw percentage profit before gas. Shows the DEX spread.
- `netProfitPct`: profit after the `gasBufferSTX` (0.5 STX) buffer. This is the number the opportunity filter uses.
- `netProfitSTX`: absolute STX profit (signed).
- `direction`: `buy_bitflow_sell_alex` or `buy_alex_sell_bitflow`.
- `buyDex` / `sellDex`: the DEX names for the two legs of the trade.
- `inputAmount` / `intermediateAmount` / `outputAmount`: the three legs in human units.

**On scan stats (diagnostic):**
- `scanStats.failureRate`: fraction of quote attempts that returned no data.
- `scanStats.pairsWithNoData`: pairs that returned zero quotes across all trade sizes.
- `warnings`: human-readable diagnostic strings, empty when everything is clean.

## Integration with execution skills
The output is designed to feed into a swap execution skill:
1. Check `status` is `success` (not `degraded`) before trusting individual opportunities.
2. Read `buyDex` and `sellDex` from the chosen opportunity.
3. Use the appropriate DEX skill to execute leg 1 (buy) with the `inputAmount`.
4. Use the other DEX skill to execute leg 2 (sell) with the actual amount received from leg 1 (not `intermediateAmount`, which was a quote-time estimate).
5. Compare realized round-trip against the scan estimate; persist slippage data for threshold tuning.

## Recommended scan frequency
- Every 5 minutes for passive monitoring.
- Every 30 seconds during high volatility (cost: each full `run` issues up to `pairs × scanAmounts × 2` quote pairs; scale `pairs` down or set `HIRO_API_KEY`).
- Stop scanning if 10 consecutive scans show no opportunities.

## Output contract shape

```json
{
  "status": "success | degraded | blocked | error",
  "action": "doctor | run",
  "data": { "...command-specific...": "..." },
  "error": null | "error message string"
}
```

See `SKILL.md` for the full `data` schema per command.

## On error
- Log the `error` string.
- Do not retry silently more than 3 times.
- Surface to the user with the `action` field + raw `error` content.
- Common errors: Bitflow or Alex API timeout, Hiro rate limit cascade, no routes found for a specific token.

## On success
- Report opportunity count and best net profit from `summary`.
- If opportunities exist, recommend execution with caveats about slippage and the scan-to-execute gap.
- Log `scannedAt` for freshness tracking.
