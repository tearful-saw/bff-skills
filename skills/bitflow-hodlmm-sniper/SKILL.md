---
name: bitflow-hodlmm-sniper
description: "Bitflow LP entry analysis with on-chain pool state reads"
metadata:
  author: "0q_bulletproof"
  author-agent: "Elegant Orb"
  user-invocable: "false"
  arguments: "doctor | run"
  entry: "bitflow-hodlmm-sniper/bitflow-hodlmm-sniper.ts"
  requires: "settings"
  tags: "read-only, defi, l2, mainnet-only"
---

# Bitflow HODLMM Sniper

## What it does
Reads on-chain state from Bitflow XYK liquidity pools (reserves, fees, LP supply) via Hiro API contract reads. For each pool, calculates the current spot price, evaluates liquidity depth, and simulates impermanent loss across 8 price scenarios (0.5x to 2x). Ranks pools by LP attractiveness using a scoring model that weighs depth, fee income, and IL risk.

## Why agents need it
An autonomous DeFi agent deciding where to provide liquidity needs to know which pool offers the best risk-adjusted return. This skill replaces manual pool comparison with a structured analysis: it tells the agent which Bitflow pool to enter, at what confidence, and what IL to expect if the price moves. Without this, LP decisions are guesswork.

## Safety notes
- **Read-only**: This skill never submits transactions, never moves funds, never accesses wallet keys.
- All data comes from on-chain contract reads via Hiro public API plus Bitflow API token discovery in doctor.
- No mandatory API keys — public Bitflow and Hiro endpoints work out of the box.
- **Optional**: set `HIRO_API_KEY` env var to raise the Hiro per-minute read-only-call quota. Without it, scanning all 5 pools (~7 reads each = 35 calls) can trip the public limit and return `status: "degraded"` with a warning.
- 300ms delay between API calls to respect rate limits.
- All contract reads have a 10-second timeout to prevent hangs.
- Pool state is a point-in-time snapshot; reserves can change between read and execution.

## Environment variables
| Name | Required | Purpose |
|------|----------|---------|
| `BITFLOW_API_HOST` | No (defaults to `https://api.bitflowapis.finance`) | Override the Bitflow API host |
| `BITFLOW_API_KEY` | No | Bitflow API key if you have one |
| `READONLY_CALL_API_HOST` | No (defaults to `https://api.hiro.so`) | Override the Hiro read-only-call host |
| `HIRO_API_KEY` | No (recommended) | Hiro API key, raises read-only-call rate limit |

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

`status` is `success` when Bitflow + Hiro APIs are reachable AND the test pool reads cleanly, `degraded` when at least one but not all are healthy, `error` only when both APIs are unreachable.

```json
{
  "status": "success",
  "action": "doctor",
  "data": {
    "bitflow": { "reachable": true, "tokenCount": 202, "apiHost": "https://api.bitflowapis.finance", "error": null },
    "hiro": { "reachable": true, "apiHost": "https://api.hiro.so", "apiKeyConfigured": false, "error": null },
    "poolRegistry": 5,
    "poolReadable": true,
    "testPool": {
      "contract": "SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.xyk-pool-stx-aeusdc-v-1-1",
      "pair": "STX/aeUSDC",
      "reserveX": "7461390075",
      "error": null
    },
    "pools": [
      { "pair": "STX/aeUSDC", "contract": "SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.xyk-pool-stx-aeusdc-v-1-1" },
      { "pair": "sBTC/STX", "contract": "SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.xyk-pool-sbtc-stx-v-1-1" },
      { "pair": "WELSH/STX", "contract": "SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.xyk-pool-welsh-stx-v-1-1" },
      { "pair": "PEPE/STX", "contract": "SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.xyk-pool-pepe-stx-v-1-1" },
      { "pair": "NOT/STX", "contract": "SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.xyk-pool-not-stx-v-1-1" }
    ],
    "ilScenarios": [0.5, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 2],
    "warnings": ["HIRO_API_KEY not set. With 5 pools and ~7 reads each, the public Hiro rate limit may degrade run scans."]
  },
  "error": null
}
```

### run output

`status` is `success` when all pools read cleanly, `degraded` when more than 20% fail (typically Hiro rate limiting — set `HIRO_API_KEY` to mitigate), `blocked` when zero pools are readable.

```json
{
  "status": "success",
  "action": "run",
  "data": {
    "analyzedAt": "2026-04-13T19:51:11.311Z",
    "poolsAnalyzed": 5,
    "poolsErrored": 0,
    "poolsRegistered": 5,
    "failureRate": 0,
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
    "errors": [],
    "warnings": [],
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
