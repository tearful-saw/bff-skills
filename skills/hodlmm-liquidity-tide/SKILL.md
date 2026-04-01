---
name: hodlmm-liquidity-tide
description: "Tracks net liquidity flow across HODLMM pools over rolling windows to detect accumulation vs distribution phases and signal optimal LP entry/exit timing."
metadata:
  author: "tearful-saw"
  author-agent: "Elegant Orb"
  user-invocable: "false"
  arguments: "doctor | snapshot | run | history"
  entry: "hodlmm-liquidity-tide/hodlmm-liquidity-tide.ts"
  requires: "wallet, settings"
  tags: "defi, read-only, mainnet-only, l2"
---

# HODLMM Liquidity Tide

## What it does
Monitors net liquidity flow across all HODLMM pools by taking periodic snapshots of total bin reserves and TVL. Compares snapshots over rolling windows (1h, 4h, 24h) to classify each pool's liquidity tide as RISING (net accumulation), FALLING (net distribution), or SLACK (neutral). Outputs a momentum score, flow rate, and confidence-weighted timing signal that tells other agents WHEN to enter or exit LP positions.

## Why agents need it
Fee spikes and APR numbers tell you a pool is active NOW — but they don't tell you whether capital is flowing IN (smart money accumulating, safe to enter) or OUT (distribution phase, danger of being exit liquidity). Liquidity flow is a leading indicator: LPs add capital before anticipated volume and remove it before anticipated drops. This skill captures that signal so agents can time entries with conviction rather than chasing lagging indicators.

## Safety notes
- **Read-only**: This skill never submits transactions or moves funds.
- **Local state**: Snapshots are stored in `~/.hodlmm-liquidity-tide.json`. Deleting this file resets the time-series (no historical comparison until snapshots accumulate).
- **API-dependent**: Requires Bitflow HODLMM API. If the API is down, snapshots cannot be taken.
- **Signal, not execution**: This skill produces timing signals. It does NOT place orders or move capital. Execution agents consume its output.
- **Mainnet only**: HODLMM pools exist only on Stacks mainnet.

## Commands

### doctor
Check API access, pool availability, and local snapshot state.
```bash
bun run hodlmm-liquidity-tide/hodlmm-liquidity-tide.ts doctor
```

### snapshot
Take a point-in-time snapshot of all HODLMM pool liquidity. Run this on a schedule (every 5–15 minutes) to build the time-series.
```bash
bun run hodlmm-liquidity-tide/hodlmm-liquidity-tide.ts snapshot
```

### run
Analyze liquidity tide across all pools using accumulated snapshots. Outputs tide direction, momentum, and timing signal per pool.
```bash
bun run hodlmm-liquidity-tide/hodlmm-liquidity-tide.ts run
bun run hodlmm-liquidity-tide/hodlmm-liquidity-tide.ts run --pool dlmm_1
```

### history
Show snapshot history and tide transitions.
```bash
bun run hodlmm-liquidity-tide/hodlmm-liquidity-tide.ts history
bun run hodlmm-liquidity-tide/hodlmm-liquidity-tide.ts history --pool dlmm_1
```

## Output contract

All outputs are JSON to stdout.

**Success (run):**
```json
{
  "status": "success",
  "action": "run",
  "data": {
    "pools": [{
      "poolId": "dlmm_1",
      "tide": "RISING",
      "momentum": 2.4,
      "confidence": "high",
      "signal": "ENTER",
      "liquidityFlowPct1h": "+3.2%",
      "liquidityFlowPct4h": "+8.1%",
      "liquidityFlowPct24h": "+12.5%",
      "reserveXFlowPct1h": "+1.1%",
      "reserveYFlowPct1h": "-0.8%",
      "tvlFlowPct1h": "+2.9%",
      "currentTvlUsd": 190265,
      "currentLiquidity": 485230,
      "snapshotsUsed": 48
    }]
  },
  "error": null
}
```

**Blocked:**
```json
{ "status": "blocked", "action": "run", "data": { "hint": "Need at least 2 snapshots. Run `snapshot` first." }, "error": "Insufficient data" }
```

## Known constraints
- Mainnet only
- Requires periodic snapshots (recommended: every 5–15 min via cron or agent scheduler)
- First meaningful tide signal requires ~1 hour of snapshots (minimum 4 data points)
- Retains up to 7 days of snapshots (older ones are pruned automatically)
- The primary metric is LP share supply (`totalLiquidity`), which only changes when LPs add or remove liquidity — swaps shift reserves between token X and Y but leave LP shares unchanged. Reserve and TVL deltas are reported as secondary context but never drive the tide classification
