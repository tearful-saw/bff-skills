---
name: hodlmm-zest-yield-router
description: "Autonomous capital allocator between HODLMM LP and Zest sBTC supply — live APY comparison with hysteresis, dwell-time, and cost-amortization, emitting a composable execution plan."
metadata:
  author: "tearful-saw"
  author-agent: "Elegant Orb"
  user-invocable: "false"
  arguments: "doctor | scan | decide | plan | run | status | history | set-mode | install-packs"
  entry: "hodlmm-zest-yield-router/hodlmm-zest-yield-router.ts"
  requires: "wallet, settings"
  tags: "defi, read-only, mainnet-only, l2"
---

# HODLMM ↔ Zest Yield Router

## What it does
Compares live HODLMM pool APR (from Bitflow `/api/app/v1/pools/:id`) against Zest Protocol's sBTC supply APY (from `pool-0-reserve-v2-0::get-reserve-state` readonly contract call) and decides, each cycle, whether to hold in HODLMM, switch to Zest, or stay put. Decisions respect hysteresis (different thresholds to enter vs exit), dwell-time (no flip-flopping), and cost-amortization (round-trip swap+gas cost spread over expected dwell days).

Output is a machine-readable execution plan that composes with existing merged skills (`hodlmm-move-liquidity`, `zest-yield-manager`, `bitflow`) per [#483](https://github.com/BitflowFinance/bff-skills/issues/483) — the router doesn't bundle; it routes.

## Why agents need it
Any agent holding sBTC-paired HODLMM LP has two active yield sources: concentrated-liquidity fees and Zest lending. Each has different sensitivity to market regime. **Picking the wrong one quietly costs 30%+ APR.** Without a router, the operator has to check APYs manually, decide a threshold, and remember when they last switched. With it, the decision becomes one JSON-returning cycle call: current allocation, live rates, threshold math, cost-amortized decision, and the exact execution steps.

## Safety notes
- **Read-only skill**. Never writes on-chain, never moves funds. All writes are delegated to downstream skills named in the `plan.steps[].invocation`.
- **Composes, does not bundle** per [#483](https://github.com/BitflowFinance/bff-skills/issues/483) composition rules. The router produces a runnable plan; the caller (or orchestrator) invokes the named skills.
- **Mainnet only**. Bitflow HODLMM + Zest V2 are mainnet-only.
- **sBTC-paired pools only** (v1). Doctor flags non-sBTC pools as unsupported.
- **State file** at `~/.hodlmm-zest-yield-router.json` (overridable via `HODLMM_ZEST_ROUTER_STATE`). No secrets stored.
- **Dwell-time enforced** — once a switch happens, `--min-dwell` hours must pass before another switch is considered. Prevents oscillation at the boundary.
- **Hysteresis** — `--enter-zest-gap` and `--enter-hodlmm-gap` are separate thresholds. Switching to Zest requires a wider gap than the reverse (or vice versa) to avoid boundary flip-flop.

## Commands

### doctor
Full environment check: HODLMM app API, Zest readonly, state file, composed skills hint.
```bash
bun run hodlmm-zest-yield-router/hodlmm-zest-yield-router.ts doctor --pool dlmm_6
```

### scan
Snapshot both rates and persist. Also fetches HODLMM TVL + 1d volume for context.
```bash
bun run hodlmm-zest-yield-router/hodlmm-zest-yield-router.ts scan --pool dlmm_6
```

### decide
Apply decision rules to the last scan (auto-refreshes if >15 min stale). Writes to history.
```bash
bun run hodlmm-zest-yield-router/hodlmm-zest-yield-router.ts decide --pool dlmm_6 \
  --enter-zest-gap 3 --enter-hodlmm-gap 2 --min-dwell 24 --cost 0.5 --dwell-days 7
```

### plan
Emit execution plan for the last decision. 3 steps when a switch is warranted; 0 steps on `stay`.
```bash
bun run hodlmm-zest-yield-router/hodlmm-zest-yield-router.ts plan --pool dlmm_6 --stx-address SP...
```

### run
Scan + decide + plan in one cycle. `--confirm` is a no-op in v1 (decision only).
```bash
bun run hodlmm-zest-yield-router/hodlmm-zest-yield-router.ts run --pool dlmm_6 --stx-address SP...
```

### status
Current mode, last switch, last scan, last decision.
```bash
bun run hodlmm-zest-yield-router/hodlmm-zest-yield-router.ts status --pool dlmm_6
```

### history
Past decisions, newest last. Default limit 50.
```bash
bun run hodlmm-zest-yield-router/hodlmm-zest-yield-router.ts history --pool dlmm_6 --limit 20
```

### set-mode
Manually set `current_mode` (hodlmm|zest|unknown). Use to bootstrap state after a manual move or imported position. Updates `last_switched_at` so dwell-time starts now.
```bash
bun run hodlmm-zest-yield-router/hodlmm-zest-yield-router.ts set-mode --pool dlmm_6 --mode hodlmm
```

### install-packs
Lists the downstream skills the plan invokes. No external packs installed by this skill.
```bash
bun run hodlmm-zest-yield-router/hodlmm-zest-yield-router.ts install-packs --pack all
```

## Output contract

All outputs are JSON to stdout. Logs go to stderr.

**Decide example (switch triggered):**
```json
{
  "status": "success",
  "action": "decide",
  "data": {
    "decision": {
      "ts": "2026-04-18T15:42:04Z",
      "decision": "switch_to_hodlmm",
      "current_mode": "zest",
      "hodlmm_apr_pct": 30.44,
      "zest_apy_pct": 0.2008,
      "gap_pct": 30.24,
      "threshold_pct": 28.07,
      "dwell_ok": true,
      "hours_since_last_switch": 48,
      "cost_model": {
        "round_trip_cost_pct": 0.5,
        "expected_dwell_days": 7,
        "net_benefit_pct": 4.17
      },
      "reason": "HODLMM APR (30.44%) beats Zest (0.2008%) by 30.24% ≥ threshold 28.07%"
    },
    "knobs": { "enter_zest_gap_pct": 3, "enter_hodlmm_gap_pct": 2, "min_dwell_hours": 24, "round_trip_cost_pct": 0.5, "expected_dwell_days": 7 }
  },
  "error": null
}
```

**Plan example (switch_to_hodlmm):**
```json
{
  "status": "success",
  "action": "plan",
  "data": {
    "pool_id": "dlmm_6",
    "decision": "switch_to_hodlmm",
    "steps": [
      {
        "order": 1,
        "action": "zest-withdraw",
        "invocation": { "type": "cli", "skill": "zest-yield-manager", "command": "run",
          "args": ["--action=withdraw", "--amount=<supplied-sbtc-sats>"] }
      },
      {
        "order": 2,
        "action": "swap-half-sbtc-to-stx",
        "invocation": { "type": "cli", "skill": "bitflow", "command": "swap",
          "args": ["--token-x", "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token",
                   "--token-y", "SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.token-stx-v-1-2",
                   "--amount-in", "<50pct-sbtc-decimal>",
                   "--slippage-tolerance", "0.03",
                   "--confirm-high-impact"] }
      },
      {
        "order": 3,
        "action": "hodlmm-deposit",
        "invocation": { "type": "user-confirm",
          "prompt": "Confirm HODLMM LP position for pool dlmm_6 has been freshly deposited (STX + sBTC ~50/50 around the active bin, DLP shares visible on-chain for wallet SP...). Orchestrator must not call `set-mode --mode hodlmm` until this is true." }
      }
    ],
    "step_count": 3,
    "notes": "execute steps in order; router does not write on-chain in v1, compose via named skills"
  },
  "error": null
}
```

**Plan example (switch_to_zest):**
```json
{
  "data": {
    "decision": "switch_to_zest",
    "steps": [
      {
        "order": 1,
        "action": "hodlmm-exit",
        "invocation": { "type": "user-confirm",
          "prompt": "Confirm HODLMM LP position for pool dlmm_6 is fully withdrawn..." }
      },
      {
        "order": 2,
        "action": "swap-stx-to-sbtc",
        "invocation": { "type": "cli", "skill": "bitflow", "command": "swap",
          "args": ["--token-x", "SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.token-stx-v-1-2",
                   "--token-y", "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token",
                   "--amount-in", "<stx-balance-decimal>",
                   "--slippage-tolerance", "0.03",
                   "--confirm-high-impact"] }
      },
      {
        "order": 3,
        "action": "zest-supply",
        "invocation": { "type": "cli", "skill": "zest-yield-manager", "command": "run",
          "args": ["--action=supply", "--amount=<sbtc-balance-sats>"] }
      }
    ]
  }
}
```

**Invocation types orchestrators must handle:**

- `type: "cli"` — spawn `<skill> <command> <args...>`. Flag shapes in these examples are verified against upstream `aibtcdev/skills` main as of 2026-04-18; do not remap flags.
- `type: "user-confirm"` — hard stop. Present `prompt` to operator. Proceed only after explicit confirmation. Used where no registry skill exposes the required primitive (HODLMM full-exit, HODLMM fresh-deposit).
- `--amount=<supplied-sbtc-sats>` is an integer placeholder (Zest has no `max` sentinel). Orchestrator must call `zest-yield-manager run --action=status` first to resolve.
- `--amount-in <decimal>` on `bitflow swap` is **decimal human-readable** (e.g. `0.00025` for 25k sats), not raw sats.
- `--slippage-tolerance` on `bitflow swap` is **decimal 0–1** (e.g. `0.03` = 3%), NOT percentage. Passing `3` would request 300% tolerance.

## Composability

Router outputs slot into:
- [`zest-yield-manager`](https://github.com/aibtcdev/skills/tree/main/zest-yield-manager) — executes Zest supply/withdraw (plan step uses `--action=<supply|withdraw> --amount=<sats>`)
- [`bitflow`](https://github.com/aibtcdev/skills/tree/main/bitflow) — executes sBTC↔STX rebalance swap (plan step uses `--token-x/--token-y <contractId> --amount-in <decimal> --slippage-tolerance <0-1> --confirm-high-impact`)
- **HODLMM full-exit and fresh-deposit are not composed via CLI** — no registry skill currently exposes these primitives. [`hodlmm-move-liquidity`](https://github.com/aibtcdev/skills/tree/main/hodlmm-move-liquidity) only re-positions an existing LP between bins. The router emits `user-confirm` invocations for both HODLMM steps; operators execute manually via Bitflow UI or a direct `dlmm-core-v-1-1 / dlmm-liquidity-router-v-1-1` contract call until a dedicated skill lands.
- [`hodlmm-bin-optimizer`](https://github.com/BitflowFinance/bff-skills/pull/507) — reads volatility upstream; router reads realized APR downstream
- [`hodlmm-il-monitor`](https://github.com/aibtcdev/skills/pull/275) — signals when IL deterioration warrants re-routing before the APR gap widens

## Known constraints

- **sBTC-only v1**. Routing is specific to sBTC-paired HODLMM + Zest sBTC supply. Other reserves (USDh, stSTX) can be added by parameterizing the reserve address.
- **Zest rate scale**. `current-liquidity-rate` is divided by `1e8` (empirically calibrated against USDh ≈ 4%, stSTX ≈ 0.01%, sBTC ≈ 0.2% live rates). AAVE ray (`1e27`) does NOT work for Zest V2.
- **HODLMM APR source**. Uses `apr24h` if present, falls back to `apr` (lifetime). 24h is more responsive to regime changes but noisier; the cost-amortization knob (`--dwell-days`) is how you temper that.
- **No direct writes in v1**. The router is decision + plan only. A future v2 may add `--execute` that shells out to the named CLIs once they expose stable, idempotent interfaces.
- **Dwell-time is wall-clock, not block-height**. If Stacks blocks stall, dwell-time still advances. Acceptable for a decision cycle running every N minutes.
- **Cost model is linear**. Round-trip cost is a fixed pct of capital; doesn't model slippage non-linearity at large TVL. For small positions (<1M sats), adequate.
