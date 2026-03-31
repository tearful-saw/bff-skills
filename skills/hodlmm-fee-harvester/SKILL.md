---
name: hodlmm-fee-harvester
description: "Estimates accrued LP fees in HODLMM bins by tracking deposits, harvests when profitable after gas, and re-deposits into optimal bins."
metadata:
  author: "tearful-saw"
  author-agent: "Elegant Orb"
  user-invocable: "false"
  arguments: "doctor | scan | harvest | history"
  entry: "hodlmm-fee-harvester/hodlmm-fee-harvester.ts"
  requires: "wallet, signing, settings"
  tags: "defi, write, mainnet-only, requires-funds, l2"
---

# HODLMM Fee Harvester

## What it does
Monitors HODLMM LP positions across pools, estimates accrued swap fees by comparing current bin reserves against a tracked deposit baseline, and executes profitable harvests. Fees in Bitflow HODLMM auto-compound into bin reserves — there is no separate claim function. This skill withdraws liquidity, isolates the fee growth, and re-deposits the principal into optimal bins around the active bin.

## Why agents need it
HODLMM LP providers earn fees passively, but those fees are invisible — locked inside growing bin reserves with no on-chain distinction between principal and yield. Without active tracking and harvesting, agents leave compounded profits at risk of impermanent loss when the active bin drifts away. This skill closes that gap: it tracks what you put in, measures what grew, and extracts the growth when gas-profitable.

## Safety notes
- **Writes to chain**: Withdraws liquidity and re-deposits. Funds leave and re-enter LP positions.
- **Minimum harvest threshold**: Will not harvest unless estimated fees exceed 2x gas cost (configurable).
- **Re-deposit by default**: Harvested principal is re-deposited into bins centered on the current active bin. Use `--no-redeposit` to withdraw only.
- **Position tracking**: Deposits are logged in `~/.hodlmm-fee-harvester.json`. If this file is lost, fee estimation resets (no principal baseline).
- **Gas cap**: 50 STX max per harvest cycle.
- **Mainnet only**: HODLMM is not available on testnet.

## Commands

### doctor
Check wallet, HODLMM API access, pool availability, and existing positions.
```bash
STX_ADDRESS=SP... bun run hodlmm-fee-harvester/hodlmm-fee-harvester.ts doctor
```

### scan
Scan all LP positions, estimate accrued fees per bin, and report harvest opportunities. Read-only.
```bash
STX_ADDRESS=SP... bun run hodlmm-fee-harvester/hodlmm-fee-harvester.ts scan
STX_ADDRESS=SP... bun run hodlmm-fee-harvester/hodlmm-fee-harvester.ts scan --pool dlmm_1
```

### harvest
Execute a fee harvest: withdraw from bins with accrued fees, pocket the growth, re-deposit principal.
```bash
STX_ADDRESS=SP... bun run hodlmm-fee-harvester/hodlmm-fee-harvester.ts harvest --pool dlmm_1 --confirm
```

### history
Show harvest history from the local ledger.
```bash
bun run hodlmm-fee-harvester/hodlmm-fee-harvester.ts history
```

## Output contract

All outputs are JSON to stdout.

**Success:**
```json
{ "status": "success", "action": "scan", "data": { "positions": [...], "totalFeesEstimated": 1234 }, "error": null }
```

**Error:**
```json
{ "status": "error", "action": "harvest", "data": null, "error": "descriptive message" }
```

**Blocked:**
```json
{ "status": "blocked", "action": "harvest", "data": { "hint": "..." }, "error": "reason" }
```

## Known constraints
- Mainnet only
- Fee estimation requires a deposit baseline — first `scan` after a fresh install records current state as baseline (no fee estimate until next scan)
- HODLMM fees auto-compound; there is no on-chain way to distinguish principal from yield without external tracking
- Harvest executes via MCP tools (`bitflow_hodlmm_remove_liquidity`, `bitflow_hodlmm_add_liquidity`)
- Gas estimation uses Hiro API STX fee rate
