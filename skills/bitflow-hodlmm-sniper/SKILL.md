---
name: bitflow-hodlmm-sniper
description: Analyzes Bitflow XYK liquidity pools on-chain to find optimal LP entry points, simulates impermanent loss at multiple price scenarios, and ranks pools by depth, fees, and risk.
author: 0q_bulletproof
author_agent: Elegant Orb
user-invocable: true
arguments: doctor | run
entry: bitflow-hodlmm-sniper/bitflow-hodlmm-sniper.ts
requires: ["@bitflowlabs/core-sdk"]
tags: [read-only, defi, l2, mainnet-only]
---

# Bitflow HODLMM Sniper

## What it does
Reads on-chain state from Bitflow XYK liquidity pools (reserves, fees, LP supply) via Hiro API contract reads. For each pool, calculates the current spot price, evaluates liquidity depth, and simulates impermanent loss across 8 price scenarios (0.5x to 2x). Ranks pools by LP attractiveness using a scoring model that weighs depth, fee income, and IL risk.

## Why agents need it
An autonomous DeFi agent deciding where to provide liquidity needs to know which pool offers the best risk-adjusted return. This skill replaces manual pool comparison with a structured analysis: it tells the agent which Bitflow pool to enter, at what confidence, and what IL to expect if the price moves. Without this, LP decisions are guesswork.

## Safety notes
- **Read-only**: This skill never submits transactions, never moves funds, never accesses wallet keys.
- All data comes from on-chain contract reads via Hiro public API. No API keys required.
- 300ms delay between API calls to respect rate limits.
- All contract reads have a 10-second timeout to prevent hangs.
- Pool state is a point-in-time snapshot; reserves can change between read and execution.

## Commands

### doctor
Checks that Bitflow SDK and Hiro API are reachable, tests on-chain pool reads, and lists all pools in the registry.

```bash
bun run bitflow-hodlmm-sniper/bitflow-hodlmm-sniper.ts doctor
```

### run
Reads on-chain state for all registered Bitflow XYK pools, analyzes reserves/fees/IL, and returns a ranked list of LP entry recommendations.

```bash
bun run bitflow-hodlmm-sniper/bitflow-hodlmm-sniper.ts run
```

## Output contract
All outputs are JSON to stdout. Diagnostic logs go to stderr.

### doctor output
```json
{
  "status": "success",
  "action": "doctor",
  "data": {
    "bitflow": { "reachable": true, "tokenCount": 201 },
    "hiro": { "reachable": true },
    "poolRegistry": 5,
    "poolReadable": true,
    "testPool": {
      "contract": "SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.xyk-pool-stx-aeusdc-v-1-1",
      "pair": "STX/aeUSDC",
      "reserveX": "7461390075"
    },
    "pools": [
      { "pair": "STX/aeUSDC", "contract": "SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.xyk-pool-stx-aeusdc-v-1-1" },
      { "pair": "sBTC/STX", "contract": "SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.xyk-pool-sbtc-stx-v-1-1" },
      { "pair": "WELSH/STX", "contract": "SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.xyk-pool-welsh-stx-v-1-1" },
      { "pair": "PEPE/STX", "contract": "SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.xyk-pool-pepe-stx-v-1-1" },
      { "pair": "NOT/STX", "contract": "SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.xyk-pool-not-stx-v-1-1" }
    ],
    "ilScenarios": [0.5, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 2]
  },
  "error": null
}
```

### run output
```json
{
  "status": "success",
  "action": "run",
  "data": {
    "analyzedAt": "2026-03-27T19:51:11.311Z",
    "poolsAnalyzed": 5,
    "poolsErrored": 0,
    "analyses": [
      {
        "pool": "WELSH/STX",
        "contract": "SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.xyk-pool-welsh-stx-v-1-1",
        "tokenX": "WELSH",
        "tokenY": "STX",
        "isActive": true,
        "reserveX": "141617220763813",
        "reserveY": "19651682825",
        "reserveXHuman": 141617220.76,
        "reserveYHuman": 19651.68,
        "spotPrice": 7206.36609,
        "totalLPTokens": "610126283889242664989830671126557615841476",
        "depthScore": "deep",
        "fees": {
          "xProtocolBps": 10,
          "xProviderBps": 20,
          "yProtocolBps": 10,
          "yProviderBps": 20,
          "totalFeeBps": 60
        },
        "ilSimulation": [
          { "priceMultiplier": 0.5, "ilPct": -5.72, "holdValueNorm": 1.5, "lpValueNorm": 1.4142 },
          { "priceMultiplier": 0.75, "ilPct": -1.03, "holdValueNorm": 1.75, "lpValueNorm": 1.7321 },
          { "priceMultiplier": 1, "ilPct": 0, "holdValueNorm": 2, "lpValueNorm": 2 },
          { "priceMultiplier": 1.25, "ilPct": -0.62, "holdValueNorm": 2.25, "lpValueNorm": 2.2361 },
          { "priceMultiplier": 2, "ilPct": -5.72, "holdValueNorm": 3, "lpValueNorm": 2.8284 }
        ],
        "entryRecommendation": {
          "signal": "enter",
          "confidence": "high",
          "reasons": [
            "Deep liquidity: 141.62M WELSH + 19.7K STX",
            "High swap fees (60 bps) generate strong LP income"
          ]
        }
      }
    ],
    "summary": {
      "bestPool": "WELSH/STX",
      "bestSignal": "enter",
      "bestConfidence": "high",
      "enterCount": 4,
      "waitCount": 1,
      "avoidCount": 0
    }
  },
  "error": null
}
```

## Known constraints
- Mainnet only (Bitflow XYK pools are mainnet contracts)
- Analyzes 5 key Bitflow XYK pools: STX/aeUSDC, sBTC/STX, WELSH/STX, PEPE/STX, NOT/STX
- IL simulation assumes constant-product (x*y=k) AMM model
- Reserves are point-in-time snapshots; values change with every swap
- LP token supply is from `get-total-supply` read-only call
- All Hiro API calls timeout after 10 seconds
- 300ms delay between API calls to stay within free-tier rate limits (50 req/min)
- Fee values are read from on-chain data vars, not hardcoded
