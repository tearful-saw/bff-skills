---
name: bitflow-smart-dca-agent
skill: bitflow-smart-dca
description: "Agent behavior rules for the Bitflow smart DCA skill."
---

# Agent Behavior — Bitflow Smart DCA

## Decision order
1. Run `doctor` to verify wallet, API, and balances.
2. Run `analyze` to assess market conditions before committing funds.
3. If signal is "buy" with medium/high confidence → proceed to `run`.
4. If signal is "wait" or "reduce" → delay or shrink the order.
5. After `run`, use `status` to track order execution.
6. Use `cancel` only if an order is stuck or conditions changed dramatically.

## Guardrails
- **NEVER bypass spend limits.** The 500 STX/order and 1000 STX/day caps are hardcoded. Do not modify them.
- **NEVER run without checking analysis first** unless the user explicitly requests `--force`.
- **NEVER drain the wallet.** The 1 STX reserve is non-negotiable — the agent needs gas to operate.
- **NEVER execute when slippage exceeds 5%.** If the quote shows > 5% impact, refuse and suggest smaller amount.
- **ALWAYS confirm intent before `run`.** This moves real funds. Surface the amount, token pair, and market signal to the user before proceeding.
- Never expose secrets or private keys in args or logs.

## Interpreting analysis results

### Recommendations
- `buy` + `high`: Strong conditions. Execute at 100% of intended amount.
- `buy` + `medium`: Decent conditions. Consider 75% of intended amount.
- `wait` + `low`: Mixed signals. Skip this cycle or use 50% amount.
- `reduce` + `medium`: Negative signals. Skip or use 25% amount max.

### Risk factors
Each risk factor names a specific metric (fee rate, congestion, hashrate). When multiple risk factors appear, the system blocks execution. Use `--force` only if you understand why each risk factor is elevated and believe it's temporary.

## Integration pattern
```
1. Cron runs `analyze` every 4 hours
2. If recommendation is "buy" → run `run --amount <calculated>`
3. Run `status` to confirm order was accepted
4. Log the orderId for tracking
```

## Output contract
Return structured JSON every time. No ambiguous success states.

```json
{
  "status": "success | error | blocked",
  "action": "next recommended action for the agent",
  "data": {},
  "error": null
}
```

## On error
- Log the error payload
- Do not retry `run` silently — each retry spends funds
- Surface to user with the `action` field guidance
- On "blocked": read the error message, it explains exactly what's wrong

## On success
- Confirm the orderId and expected output amount
- Log market conditions at time of order for post-hoc analysis
- Schedule a `status` check in 30 minutes to verify execution
