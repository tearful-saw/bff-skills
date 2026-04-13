---
name: bitflow-alex-spread-scanner
description: Cross-DEX spread scanner that detects price discrepancies between Bitflow and Alex on Stacks, calculates round-trip profitability after fees and gas. Read-only.
author: 0q_bulletproof
author_agent: Elegant Orb
user-invocable: true
arguments: doctor | run
entry: bitflow-alex-spread-scanner/bitflow-alex-spread-scanner.ts
requires: []
tags: [read-only, defi, l2, infrastructure]
---

# Bitflow ↔ Alex Spread Scanner

## What it does
Scans for cross-DEX spread opportunities between Bitflow and Alex on Stacks. Dynamically discovers common token pairs, fetches live quotes from both DEXes in both directions at multiple trade sizes, and classifies opportunities by *net* profitability (after a fixed 0.5 STX gas buffer). The fees quoted by each DEX are inherited from their own `getQuoteForRoute` / `getAmountTo` responses; this skill does not add a separate fee model on top.

## Why agents need it
Autonomous trading agents need to know *where* prices diverge before executing. This skill provides the signal layer — it tells the agent which token, which direction, and how much net profit exists at each trade size right now. Without this, agents are trading blind across a fragmented DEX landscape.

## Safety notes
- **Read-only**: this skill never submits transactions, never moves funds, never accesses wallet keys. It only reads public quote endpoints on Bitflow and Alex plus Hiro read-only contract calls.
- No mandatory API keys — public Bitflow, Alex, and Hiro endpoints work out of the box.
- **Optional**: set `HIRO_API_KEY` env var to raise the Hiro per-minute read-only-call quota. Without it, large pair sets can trip rate limits and the skill will return `status: "degraded"` with a warning (see Output contract).
- Quotes are point-in-time snapshots; prices may move before execution.

## Environment variables
| Name | Required | Purpose |
|------|----------|---------|
| `BITFLOW_API_HOST` | No (defaults to `https://api.bitflowapis.finance`) | Override the Bitflow API host |
| `BITFLOW_API_KEY`  | No | Bitflow API key if you have one |
| `READONLY_CALL_API_HOST` | No (defaults to `https://api.hiro.so`) | Override the Hiro read-only-call host |
| `HIRO_API_KEY` | No (recommended for ≥5 pairs) | Hiro API key, raises rate limit |

## Commands

### doctor
Checks that Bitflow and Alex APIs are reachable, discovers common token pairs, and reports scan readiness + env status.

```bash
bun run bitflow-alex-spread-scanner/bitflow-alex-spread-scanner.ts doctor
```

### run
Scans all discovered token pairs at `[1, 10, 50, 100]` STX sizes in both directions. Reports profitable opportunities (netProfitPct > 0.1%) sorted by net profitability, plus per-pair spread diagnostics for pairs with no profitable window.

```bash
bun run bitflow-alex-spread-scanner/bitflow-alex-spread-scanner.ts run
```

## Output contract
All output is a single JSON object to stdout. Log lines go to stderr.

### `doctor` output

`status` is `success` when both Bitflow and Alex are reachable, `degraded` when one is down (per-API `reachable: false` + `error` is surfaced), `error` only on unrecoverable failure (e.g., process-level crash).

```json
{
  "status": "success",
  "action": "doctor",
  "data": {
    "bitflow": { "reachable": true, "tokenCount": 202, "apiHost": "https://api.bitflowapis.finance", "error": null },
    "alex":    { "reachable": true, "tokenCount": 29, "error": null },
    "hiro":    { "apiHost": "https://api.hiro.so", "apiKeyConfigured": false },
    "matchedTokens": 27,
    "commonPairs": [
      { "tokenA": "STX", "tokenB": "WELSH", "bitflowIds": ["token-stx","token-welsh"], "alexIds": ["token-wstx","token-wcorgi"] }
    ],
    "scanReadyPairCount": 7,
    "scanAmountsSTX": [1, 10, 50, 100],
    "gasBufferSTX": 0.5,
    "minProfitPct": 0.1,
    "warnings": ["HIRO_API_KEY not set. With 7 scan-ready pairs, Hiro's public rate limit may cause partial scan failures."]
  },
  "error": null
}
```

When one API is down, output looks like:

```json
{
  "status": "degraded",
  "action": "doctor",
  "data": {
    "bitflow": { "reachable": true,  "tokenCount": 202, "apiHost": "...", "error": null },
    "alex":    { "reachable": false, "tokenCount": 0,   "error": "fetch failed: ECONNRESET" },
    "matchedTokens": 0,
    "commonPairs": [],
    "scanReadyPairCount": 0,
    "warnings": ["alex_unreachable: fetch failed: ECONNRESET", "partial_outage: pair discovery skipped; resolve API connectivity before running scans."]
  },
  "error": null
}
```

### `run` output

`status` is one of `success` | `degraded` | `blocked` | `error`.
- `success`: all quote attempts returned data.
- `degraded`: more than 20% of quote attempts failed (typically Hiro rate limits). Consumers should treat opportunities as partial.
- `blocked`: no common pairs discovered at all.
- `error`: unrecoverable SDK or config failure; see `error` field.

```json
{
  "status": "degraded",
  "action": "run",
  "data": {
    "scannedAt": "2026-04-13T12:27:13.177Z",
    "scanAmountsSTX": [1, 10, 50, 100],
    "gasBufferSTX": 0.5,
    "minProfitPct": 0.1,
    "pairsScanned": 7,
    "opportunities": [
      {
        "pair": "STX/WELSH",
        "direction": "buy_alex_sell_bitflow",
        "buyDex": "Alex",
        "sellDex": "Bitflow",
        "inputAmount": 100,
        "inputToken": "STX",
        "intermediateAmount": 123456.78,
        "intermediateToken": "WELSH",
        "outputAmount": 103.0,
        "outputToken": "STX",
        "grossProfitPct": 3.0,
        "netProfitSTX": 2.5,
        "netProfitPct": 2.5,
        "confidence": "high"
      }
    ],
    "pairSummaries": [
      {
        "pair": "STX/WELSH",
        "scansCompleted": 4,
        "scansAttempted": 4,
        "spreads": [
          { "amountSTX": 100, "direction": "buy_alex_sell_bitflow", "grossProfitPct": 3.0, "netProfitPct": 2.5, "roundTripCostPct": 0 }
        ],
        "bestGrossProfitPct": 3.0,
        "bestNetProfitPct": 2.5,
        "hasOpportunity": true
      }
    ],
    "scanStats": {
      "totalAttempts": 28,
      "totalFailures": 13,
      "failureRate": 0.464,
      "pairsWithNoData": 3,
      "quoteErrorsLogged": 1
    },
    "warnings": [
      "high_scan_failure_rate: 46% of scan attempts returned no usable quote pair (13/28). Likely Hiro API rate limiting. Set HIRO_API_KEY env var to raise the read-only-call quota.",
      "3/7 pairs returned zero quote data across all scan sizes."
    ],
    "summary": {
      "totalOpportunities": 1,
      "bestOpportunityPair": "STX/WELSH",
      "bestGrossProfitPct": 3.0,
      "bestNetProfitPct": 2.5,
      "avgSmallTradeCostPct": 0.93
    }
  },
  "error": null
}
```

### Confidence tiers
`netProfitPct` bucketing, checked after gas buffer:
- `high`: netProfitPct > 2%
- `medium`: 0.5% < netProfitPct ≤ 2%
- `low`: 0 < netProfitPct ≤ 0.5% (reported but marginal — consumers should re-verify)

## Known constraints
- Mainnet only (both Bitflow and Alex are mainnet-only).
- **Pair discovery is limited to X/STX pairs** — the scanner does not detect cross-pair arbitrage (e.g., WELSH/sBTC) to avoid decimal-mismatch edge cases between DEX quote conventions. STX is the base currency for every detected opportunity.
- Quotes are snapshots — price slippage between scan and execution is not accounted for.
- Gas estimate is a fixed 0.5 STX buffer for 2 transactions; actual micro-block fees vary.
- Does not detect MEV, front-running risk, or liquidity fragmentation.
- `minProfitPct` filter is applied to *net* profit after gas; very small trade sizes may therefore never surface as opportunities even if the gross spread is positive.
- Hiro read-only-call rate limits hit hard on ≥5 simultaneous pairs without `HIRO_API_KEY`; this will surface as `status: "degraded"`.
- `doctor` is partial-failure tolerant — if Bitflow is reachable but Alex is not (or vice versa), it returns `status: "degraded"` with per-API `reachable` / `error` fields rather than failing hard.
