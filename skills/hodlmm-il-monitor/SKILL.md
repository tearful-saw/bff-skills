---
name: hodlmm-il-monitor
description: "Real-time impermanent loss tracker for HODLMM concentrated-liquidity positions — compares live LP value to a HODL-only baseline."
metadata:
  author: "tearful-saw"
  author-agent: "Elegant Orb"
  user-invocable: "false"
  arguments: "doctor | snapshot | status | run | history | install-packs"
  entry: "hodlmm-il-monitor/hodlmm-il-monitor.ts"
  requires: "wallet, settings"
  tags: "defi, read-only, mainnet-only, l2"
---

# HODLMM IL Monitor

## What it does
Tracks impermanent loss on live HODLMM concentrated-liquidity positions by recording an entry snapshot (token amounts + price at deposit) and continuously comparing it to the current LP state. Reports IL as a percentage, estimates fee income, and computes net P&L (IL + fees vs HODL). Classifies positions by severity (healthy / mild / severe) and emits actionable alerts when IL exceeds thresholds.

## Why agents need it
Concentrated liquidity amplifies both fee income and impermanent loss. An LP position can be earning fees while simultaneously losing value to IL — and the net effect isn't obvious without tracking both. This skill gives agents a real-time "should I stay or should I go" signal: when net P&L turns negative (fees < IL), it's time to recenter or exit. Composes directly with `hodlmm-range-keeper` to trigger recenters when IL grows.

## Safety notes
- **Read-only**: This skill never writes to chain or moves funds.
- **State file**: Writes entry snapshots and history to `~/.hodlmm-il-monitor.json` locally.
- **No fund risk**: All operations are observational.
- **Mainnet only**: HODLMM is not available on testnet.

## Commands

### doctor
Check wallet, HODLMM API access, pool availability, existing positions, and tracker state. Safe to run anytime.
```bash
STX_ADDRESS=SP... bun run hodlmm-il-monitor/hodlmm-il-monitor.ts doctor
```

### snapshot
Record current position as IL entry baseline. First snapshot per pool sets the reference point; subsequent snapshots require `--force` to overwrite.
```bash
STX_ADDRESS=SP... bun run hodlmm-il-monitor/hodlmm-il-monitor.ts snapshot
STX_ADDRESS=SP... bun run hodlmm-il-monitor/hodlmm-il-monitor.ts snapshot --pool dlmm_1
STX_ADDRESS=SP... bun run hodlmm-il-monitor/hodlmm-il-monitor.ts snapshot --pool dlmm_1 --force
```

### status
Show current IL for all tracked positions. Fetches live prices, compares to entry snapshot, classifies severity, and recommends action.
```bash
STX_ADDRESS=SP... bun run hodlmm-il-monitor/hodlmm-il-monitor.ts status
STX_ADDRESS=SP... bun run hodlmm-il-monitor/hodlmm-il-monitor.ts status --pool dlmm_1
```

### run
Full autonomous cycle: discover positions across all pools, snapshot any new ones, calculate IL for existing, record history, and emit alerts. Designed for cron.
```bash
STX_ADDRESS=SP... bun run hodlmm-il-monitor/hodlmm-il-monitor.ts run
```

### history
Show IL trend over time. Useful for spotting worsening IL patterns or confirming that fees are outpacing loss.
```bash
bun run hodlmm-il-monitor/hodlmm-il-monitor.ts history
bun run hodlmm-il-monitor/hodlmm-il-monitor.ts history --pool dlmm_1 --limit 50
```

### install-packs
No external packs required. Returns success immediately.
```bash
bun run hodlmm-il-monitor/hodlmm-il-monitor.ts install-packs --pack all
```

## Output contract

All outputs are JSON to stdout. Logs go to stderr.

**Status example:**
```json
{
  "status": "success",
  "action": "status",
  "data": {
    "summary": { "positionsTracked": 2, "healthy": 1, "mild": 1, "severe": 0, "profitableAfterFees": 1 },
    "positions": [
      {
        "poolId": "dlmm_1",
        "priceChange": "+3.2%",
        "ilPercent": "-1.8%",
        "netPnlPercent": "+0.4%",
        "severity": "mild",
        "recommendation": "monitor"
      }
    ]
  },
  "error": null
}
```

**Run with alerts:**
```json
{
  "status": "success",
  "action": "run",
  "data": {
    "poolsScanned": 5,
    "positionsFound": 2,
    "newSnapshotsCreated": [],
    "ilReadings": 2,
    "alerts": ["dlmm_1: IL at -6.2% — consider recenter or exit"],
    "positions": [{ "poolId": "dlmm_1", "ilPercent": -6.2, "netPnlPercent": -2.1, "recommendation": "consider_recenter" }]
  },
  "error": null
}
```

## Known constraints
- Mainnet only — HODLMM has no testnet deployment
- Entry snapshot must be taken before IL can be calculated — first `run` auto-snapshots new positions but reports IL as zero until the next cycle
- Price is sourced from the HODLMM active bin, which may lag 1-2 blocks behind chain state
- Fee estimation is a heuristic: reserve growth above entry baseline. Does not capture fees already claimed via `hodlmm-fee-harvester` — coordinate to avoid double-counting
- IL percentages are relative to entry, not annualized
- If a position was recentered by `hodlmm-range-keeper`, the old snapshot becomes stale — re-snapshot after recenter
