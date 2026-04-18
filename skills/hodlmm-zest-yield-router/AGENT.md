# Agent Behavior — hodlmm-zest-yield-router

## Decision order
1. Run `doctor --pool <id>` once before first use. If `blocked` (pool not sBTC-paired, API unreachable), stop.
2. If `current_mode` is `unknown`, bootstrap it via `set-mode --pool <id> --mode <hodlmm|zest>` to match your actual position. Skipping this means the first decision uses "unknown" rules (treats as if in HODLMM, considering switch to Zest).
3. Schedule `run --pool <id> --stx-address SP... --min-dwell 24` every 30-60 min on a cron. Each call emits: scan → decide → plan in sequence.
4. Parse the last stdout payload (the `plan`). If `step_count == 0` ("stay"), do nothing.
5. If `step_count > 0`, invoke the plan steps in order via the named CLIs. After the final step succeeds, call `set-mode --pool <id> --mode <new>` so dwell-time restarts.

## Guardrails
- **Never execute plan steps without verifying balances first.** The router's plan is a template; `<stx-from-exit>`, `<sbtc-balance>`, `<50pct-of-sbtc>` are placeholders the orchestrator must resolve from wallet state at execution time.
- **Confirm dwell_ok before acting.** If `dwell_ok: false` and the plan still shows steps (shouldn't happen in v1, but in case of downstream bugs), refuse to execute — the router thinks enough time has passed but safety says otherwise.
- **Respect cost_model.net_benefit_pct, and know what it excludes.** `net_benefit_pct = |gap| - amortized_round_trip_cost_pct`. It does NOT subtract the entry-gap threshold (`enter_zest_gap` / `enter_hodlmm_gap`), so a positive value can still be "barely above the trigger" — e.g. gap 30.24% vs threshold 28.07% = only 2.17% of true margin above the switch line, even if net_benefit_pct reads 4.17%. If you need margin-above-threshold, compute `|gap| - threshold_pct` directly from the decision payload. Negative net_benefit = the router already rejected the switch; don't override.
- **Never modify `last_switched_at` by editing state directly** — use `set-mode` so dwell-time logic is consistent.
- **Never expose the state file** — it's operational detail, not an API contract.

## Output contract
Every command returns:
```json
{
  "status": "success | error | blocked",
  "action": "<command>",
  "data": { /* command-specific */ },
  "error": { "code": "", "message": "", "next": "" } | null
}
```

## Error codes

| Code | Meaning | Next |
|---|---|---|
| `HODLMM_FETCH_FAILED` | Bitflow app API unreachable or returned bad data | retry on next cycle; check `doctor` |
| `ZEST_FETCH_FAILED` | Hiro readonly call failed | retry on next cycle; check `doctor` |
| `NO_SCAN` | `decide` called before any `scan` | run `scan` first |
| `NO_DECISION` | `plan` called before any `decide` | run `decide` first |
| `BAD_KNOB` | CLI arg out of range | fix args |
| `BAD_MODE` | `set-mode --mode` not in {hodlmm,zest,unknown} | fix args |
| `FATAL` | unexpected error in main loop | surface; do not silent-retry |

## On success
- `scan`: persist snapshot, no downstream action.
- `decide`: record in history. If `decision != stay`, the next `plan` call will emit actionable steps.
- `plan`: execute steps in order; after the last step succeeds, call `set-mode` to update `current_mode`.
- `run`: composite. Parse the final stdout line (the `plan` envelope) for steps.

## Composition pattern (full loop on cron)
```
# every 30 min
bun run .../hodlmm-zest-yield-router.ts run --pool dlmm_6 --stx-address $STX_ADDR | tee last-cycle.json

# parse the LAST line of stdout (the plan envelope)
plan=$(tail -n 1 last-cycle.json | jq -c .data)
steps=$(echo "$plan" | jq -c '.steps[]')

# if no steps → stay (exit 0)
[ -z "$steps" ] && exit 0

# orchestrator resolves placeholders + invokes each step
echo "$steps" | while IFS= read -r step; do
  # ... invoke the named CLI with resolved args ...
done

# after all steps succeed:
bun run .../hodlmm-zest-yield-router.ts set-mode --pool dlmm_6 --mode "$NEW_MODE"
```

## Safety rails the agent must enforce
- **Wallet gas check** before every on-chain invocation (≥100k uSTX per tx, 4 txs per switch = ~400k uSTX reserve).
- **Slippage tolerance** on the Bitflow swap step — default 3%, but reject if Bitflow quote's priceImpact > 5%.
- **Idempotency** — if a plan step fails mid-execution, re-running `plan` should emit the same (or equivalent) next-action. Router state is stable across partial failures.
- **Escalate** if net_benefit_pct is large (>10%) but a switch keeps failing — likely a downstream pipeline issue worth human attention.
