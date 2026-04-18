---
name: hodlmm-bin-optimizer
description: "Volatility-driven bin-radius recommender for HODLMM concentrated-liquidity — converts observed active-bin behavior into a defensible range configuration."
metadata:
  author: "tearful-saw"
  author-agent: "Elegant Orb"
  user-invocable: "false"
  arguments: "doctor | sample | bootstrap | suggest | config | history | install-packs"
  entry: "hodlmm-bin-optimizer/hodlmm-bin-optimizer.ts"
  requires: "settings"
  tags: "defi, read-only, mainnet-only, l2"
---

# HODLMM Bin Optimizer

## What it does
Observes the active_bin of a HODLMM pool over time, computes its volatility, and emits a recommended bin-radius (how many bins above and below to deploy liquidity across) for a target coverage level — e.g. "I want to stay in-range 90% of the time with 10,000 STX." Output is a `range_keeper_config` JSON block that `hodlmm-range-keeper` (or any DLMM deposit flow) can consume directly.

## Why agents need it
`hodlmm-range-keeper` moves liquidity to the active bin, but it takes bin-radius as a fixed input. Pick too narrow → constant recentering (gas drag). Pick too wide → capital dilutes across inactive bins earning zero fees. This skill closes that loop: the agent runs `sample` on a cron, accumulates observations, and periodically calls `suggest` to re-derive the right width from actual pool behavior. No more guessing; the config is data-driven.

## Safety notes
- **Read-only**: never writes on-chain and never moves funds.
- **State**: local JSON at `~/.hodlmm-bin-optimizer.json` (overridable via `HODLMM_BIN_OPTIMIZER_STATE`). Bounded at 10,000 samples per pool.
- **Recommendation ≠ execution**: the skill *suggests* a range-keeper config. Deposit decisions stay with the operator or downstream writer.
- **Mainnet only**: HODLMM is not available on testnet.

## Commands

### doctor
Check HODLMM API reachability, pool existence, state file, and Hiro API key availability for bootstrap.
```bash
bun run hodlmm-bin-optimizer/hodlmm-bin-optimizer.ts doctor
bun run hodlmm-bin-optimizer/hodlmm-bin-optimizer.ts doctor --pool dlmm_6
```

### sample
Record the pool's current active_bin + price to local history. Designed for cron (every 5–15 min); each call is one observation.
```bash
bun run hodlmm-bin-optimizer/hodlmm-bin-optimizer.ts sample --pool dlmm_6
```

### bootstrap
One-shot historical backfill from Hiro contract events. Parses `active-bin`-bearing log entries from the pool's core contract. Best-effort: emits a `BOOTSTRAP_EMPTY` `blocked` status if no parseable events surface, in which case the fallback is organic `sample` collection. `HIRO_API_KEY` recommended but not required.
```bash
bun run hodlmm-bin-optimizer/hodlmm-bin-optimizer.ts bootstrap --pool dlmm_6 --hours 24
```

### suggest
Compute recommended bin-radius from accumulated history over a lookback window. Requires ≥5 in-window samples; otherwise returns `INSUFFICIENT_HISTORY` with guidance. Persists the last suggest for audit + `config` retrieval.
```bash
bun run hodlmm-bin-optimizer/hodlmm-bin-optimizer.ts suggest --pool dlmm_6 --lookback 24 --coverage 0.90 --capital 10000
```

### config
Emit the most recent suggest as a `range_keeper_config` JSON block consumable by `hodlmm-range-keeper`. No recomputation — read-only.
```bash
bun run hodlmm-bin-optimizer/hodlmm-bin-optimizer.ts config --pool dlmm_6
```

### history
Dump the most recent observations for a pool.
```bash
bun run hodlmm-bin-optimizer/hodlmm-bin-optimizer.ts history --pool dlmm_6 --limit 100
```

### install-packs
No external packs required. Returns success immediately.
```bash
bun run hodlmm-bin-optimizer/hodlmm-bin-optimizer.ts install-packs --pack all
```

## Output contract

All outputs are JSON to stdout. Logs go to stderr. Every command returns:
```json
{
  "status": "success | error | blocked",
  "action": "<command>",
  "data": { /* command-specific payload */ },
  "error": { "code": "...", "message": "...", "next": "..." } | null
}
```

**Suggest example:**
```json
{
  "status": "success",
  "action": "suggest",
  "data": {
    "pool_id": "dlmm_6",
    "current_active_bin": 299,
    "volatility": {
      "samples": 288,
      "lookback_hours": 24,
      "mean_bin_id": 299.1,
      "bin_id_std": 3.4,
      "p5_bin_id": 294,
      "p95_bin_id": 304,
      "min_bin_id": 291,
      "max_bin_id": 306,
      "max_excursion": 7.9
    },
    "recommendation": {
      "coverage_target": 0.9,
      "bin_radius": 9,
      "bin_count": 19,
      "min_bin_id": 290,
      "max_bin_id": 308,
      "expected_coverage_pct": 91.2,
      "capital_per_bin_stx": 526.3158,
      "total_capital_stx": 10000
    },
    "range_keeper_config": {
      "poolId": "dlmm_6",
      "centerBinOffset": 0,
      "binRadius": 9,
      "stxAmountPerBin": 526315800
    },
    "confidence": "high",
    "reason": "288 samples over 24h, std=3.4, excursion=7.9 bins → recommended radius 9 (z=1.65)",
    "computed_at": "2026-04-18T16:00:00Z"
  },
  "error": null
}
```

## Composability

- **`hodlmm-range-keeper`** — consumes `range_keeper_config` directly. Typical flow: `bin-optimizer sample` on a 5-min cron → `bin-optimizer suggest` daily → feed `config` into `range-keeper run`.
- **`hodlmm-il-monitor`** — complementary observer. If IL monitor reports worsening IL AND optimizer shows rising volatility → re-widen and recenter together.
- **`hodlmm-liquidity-tide`** — provides pool-level liquidity flow context; this skill reports active-bin behavior for *your own* deployment decision.

## Known constraints
- **Cold start**: first samples build slowly. `bootstrap` from Hiro is best-effort; typical fallback is 24h of organic `sample` runs before `suggest` has ≥5 samples.
- **No price-space model**: recommendations are in bin-space. For pools with unusual `bin_step` (e.g. 1 bps for stable pairs), the same bin-radius implies very different price ranges. Operator should interpret with pool `bin_step` in mind.
- **Equal-weighted window**: v1 uses a uniform window. EWMA / regime-change detection is future work.
- **Excursion floor**: radius is always ≥ max historical excursion × 1.1 to prevent fitting only to the std when a single long tail exists.
- **MIN_RADIUS = 2, MAX_RADIUS = 50**: hardcoded safety caps.
