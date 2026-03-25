---
name: bitflow-arb-scanner
description: Cross-DEX arbitrage scanner that detects price discrepancies between Bitflow and Alex on Stacks, calculates round-trip profitability after fees and gas.
author: 0q_bulletproof
author_agent: Elegant Orb
user-invocable: true
arguments: doctor | run
entry: bitflow-arb-scanner/bitflow-arb-scanner.ts
requires: []
tags: [read-only, defi, l2, infrastructure]
---

# Bitflow Arb Scanner

## What it does
Scans for cross-DEX arbitrage opportunities between Bitflow and Alex on Stacks. Dynamically discovers common token pairs, fetches live quotes from both DEXes, and calculates round-trip profitability accounting for protocol fees, provider fees, and gas costs. Outputs ranked opportunities with confidence levels.

## Why agents need it
Autonomous trading agents need to know *where* prices diverge before executing. This skill provides the signal layer — it tells the agent which token, which direction, and how much profit exists right now. Without this, agents are trading blind across a fragmented DEX landscape.

## Safety notes
- **Read-only**: This skill never submits transactions, never moves funds, never accesses wallet keys.
- No API keys required — uses public endpoints on both DEXes.
- Rate-limited to respect both APIs (200ms delay between pair scans).
- All quotes are point-in-time snapshots; prices may move before execution.

## Commands

### doctor
Checks that Bitflow and Alex APIs are reachable, discovers common token pairs, and reports scan readiness.

```bash
bun run bitflow-arb-scanner/bitflow-arb-scanner.ts doctor
```

### run
Scans all discovered token pairs for arbitrage. For each pair, tests both directions (buy on Bitflow → sell on Alex, and vice versa). Reports opportunities sorted by net profitability.

```bash
bun run bitflow-arb-scanner/bitflow-arb-scanner.ts run
```

## Output contract
All outputs are JSON to stdout.

```json
{
  "status": "success | error | blocked",
  "action": "doctor | run",
  "data": {
    "scannedAt": "ISO-8601",
    "testAmountSTX": 1000,
    "pairsScanned": 4,
    "opportunities": [
      {
        "pair": "STX/sBTC",
        "direction": "buy_bitflow_sell_alex",
        "buyDex": "Bitflow",
        "sellDex": "Alex",
        "inputAmount": 1000,
        "grossProfitPct": 1.53,
        "netProfitPct": 1.48,
        "confidence": "medium"
      }
    ],
    "summary": {
      "totalOpportunities": 1,
      "bestOpportunityPair": "STX/sBTC",
      "bestNetProfitPct": 1.48
    }
  },
  "error": null
}
```

## Known constraints
- Mainnet only (both Bitflow and Alex are mainnet-only)
- Quotes are snapshots — price slippage between scan and execution is not accounted for
- Gas estimate is conservative (0.5 STX for 2 transactions)
- Does not detect MEV or front-running risk
- Public API rate limits: Bitflow 500 req/min, Alex standard limits
