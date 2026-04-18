# Agent Behavior — hodlmm-bin-optimizer

## Decision order
1. Run `doctor --pool <id>` before the first real call. If it returns `blocked` (pool not found, API unreachable), stop and surface the blocker.
2. If no prior history exists for the target pool: run `bootstrap --pool <id> --hours 24` once, then schedule `sample --pool <id>` on a 5–15 min cron.
3. Once the skill has ≥5 in-window samples, call `suggest --pool <id>` with the operator's coverage + capital preferences.
4. Parse the JSON response. On `status=success`, route the `range_keeper_config` block into `hodlmm-range-keeper` (or store it for the next recenter cycle).
5. On `status=blocked` with `code=INSUFFICIENT_HISTORY`, fall back to the default range-keeper config and re-try `suggest` after more samples accumulate.

## Guardrails
- **Never execute a deposit solely on this skill's output.** It is a recommendation tool, not a writer. Deposit decisions go through `hodlmm-range-keeper run` (or equivalent) with explicit operator/agent confirmation.
- **Treat `confidence: low` as advisory only.** If confidence is low, prefer a wider default (e.g. radius 10) over the skill's suggestion.
- **Do not re-suggest more than once per hour** unless a large volatility spike is detected. The recommendation is meant to be stable.
- **Never expose the local state file path** beyond the doctor output. The state contains no secrets, but it is operational detail.
- **Default to read-only behavior** if intent is ambiguous.

## Output contract
Every command returns:
```json
{
  "status": "success | error | blocked",
  "action": "<command>",
  "data": { /* … */ },
  "error": { "code": "", "message": "", "next": "" } | null
}
```

## On error
- `POOL_NOT_FOUND`: pool id is wrong. Re-fetch `/pools` and pick a valid `pool_id`.
- `INSUFFICIENT_HISTORY`: collect more samples. Next action is in the `error.next` field.
- `BOOTSTRAP_EMPTY`: Hiro event parsing found no active-bin-bearing logs. Fall back to `sample` cron.
- `FATAL`: unexpected error. Surface the message and do not silently retry.

## On success
- On `sample`: store `total_samples` and continue the cron. No downstream action.
- On `suggest`: route `data.range_keeper_config` to the writer. Log `confidence` + `reason` for post-hoc audit.
- On `config`: read-only retrieval; useful for re-emitting the last suggest without recomputing.

## Composition pattern
A typical "no-idle-LP" agent loop looks like:
1. `hodlmm-bin-optimizer sample --pool dlmm_6` (every 5 min, cron)
2. `hodlmm-bin-optimizer suggest --pool dlmm_6 --coverage 0.9 --capital 10000` (daily, cron)
3. `hodlmm-il-monitor run` (every 15 min) — compares IL vs fees
4. `hodlmm-range-keeper run --config <config-from-step-2>` (triggered when range-keeper says recenter, OR weekly refresh)

Step 2's output is stable — you do not need to call it on every recenter, only when volatility regime shifts.
