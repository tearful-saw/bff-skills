---
name: bitflow-arb-scanner
description: Cross-DEX arbitrage scanner that detects price discrepancies between Bitflow and Alex on Stacks, calculates round-trip profitability after fees and gas.
author: 0q_bulletproof
author_agent: Elegant Orb
user-invocable: true
arguments: doctor | run
entry: bitflow-arb-scanner/bitflow-arb-scanner.ts
requires: ["@bitflowlabs/core-sdk", "alex-sdk"]
tags: [read-only, defi, l2, infrastructure]
---

# Bitflow Arb Scanner

## What it does
Scans for cross-DEX arbitrage opportunities between Bitflow and Alex on Stacks. Dynamically discovers common token pairs, fetches live quotes from both DEXes at multiple trade sizes (1, 10, 50, 100 STX), and calculates round-trip profitability accounting for protocol fees, provider fees, and gas costs. Outputs ranked opportunities with confidence levels and per-pair spread curves.

## Why agents need it
Autonomous trading agents need to know *where* prices diverge before executing. This skill provides the signal layer — it tells the agent which token, which direction, and how much profit exists right now. Without this, agents are trading blind across a fragmented DEX landscape.

## Safety notes
- **Read-only**: This skill never submits transactions, never moves funds, never accesses wallet keys.
- No API keys required — uses public endpoints on both DEXes.
- Rate-limited to respect both APIs (300ms delay between pair scans).
- All SDK calls have a 10-second timeout to prevent hangs.
- All quotes are point-in-time snapshots; prices may move before execution.

## Commands

### doctor
Checks that Bitflow and Alex APIs are reachable, discovers common token pairs, and reports scan readiness.

```bash
bun run bitflow-arb-scanner/bitflow-arb-scanner.ts doctor
```

### run
Scans all discovered token pairs for arbitrage at multiple trade sizes. For each pair, tests both directions (buy on Bitflow → sell on Alex, and vice versa). Reports opportunities sorted by net profitability. Default command if no argument given.

```bash
bun run bitflow-arb-scanner/bitflow-arb-scanner.ts run
```

## Output contract
All outputs are JSON to stdout. Diagnostic logs go to stderr.

```json
{
  "status": "success",
  "action": "run",
  "data": {
    "scannedAt": "2026-03-26T20:30:24.380Z",
    "scanAmountsSTX": [1, 10, 50, 100],
    "gasBufferSTX": 0.5,
    "pairsScanned": 7,
    "warnings": [],
    "opportunities": [
      {
        "pair": "STX/WELSH",
        "direction": "buy_bitflow_sell_alex",
        "buyDex": "Bitflow",
        "sellDex": "Alex",
        "inputAmount": 1,
        "inputToken": "STX",
        "intermediateAmount": 7002.15,
        "intermediateToken": "WELSH",
        "outputAmount": 0.99,
        "outputToken": "STX",
        "grossProfitPct": 0.35,
        "netProfitSTX": -0.02,
        "netProfitPct": -0.15,
        "confidence": "low"
      }
    ],
    "pairSummaries": [
      {
        "pair": "STX/WELSH",
        "spreads": [
          {"amountSTX": 1, "direction": "buy_bitflow_sell_alex", "grossProfitPct": -0.26, "roundTripCostPct": 0.26},
          {"amountSTX": 10, "direction": "buy_bitflow_sell_alex", "grossProfitPct": -0.77, "roundTripCostPct": 0.77}
        ],
        "bestProfitPct": -0.26,
        "hasOpportunity": false
      }
    ],
    "summary": {
      "totalOpportunities": 0,
      "bestOpportunityPair": null,
      "bestGrossProfitPct": 0,
      "bestNetProfitPct": 0,
      "avgSmallTradeCostPct": 0.94
    }
  },
  "error": null
}
```

## Known constraints
- Mainnet only (both Bitflow and Alex are mainnet-only)
- Scans STX-base pairs only to avoid cross-token decimal conversion issues
- Quotes are snapshots — price slippage between scan and execution is not accounted for
- Gas estimate is conservative (0.5 STX for 2 transactions)
- SDK calls timeout after 10 seconds to prevent hangs
- Does not detect MEV or front-running risk
- Public API rate limits: Bitflow 500 req/min, Alex uses Hiro API (50 req/min free tier)
- For faster scans or more pairs, use a Hiro API key ($50+/mo at hiro.so/pricing) via `STACKS_API_KEY` env var
- Default 300ms delay between quotes balances throughput vs free-tier limits
