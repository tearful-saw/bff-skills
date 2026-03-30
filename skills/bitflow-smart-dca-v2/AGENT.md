---
name: bitflow-smart-dca-v2-agent
skill: bitflow-smart-dca-v2
description: "Agent behavior rules for the Bitflow Smart DCA v2 skill with HODLMM LP deployment."
---

# Agent Behavior — Bitflow Smart DCA v2

## Decision order
1. Run `doctor` to verify wallet, APIs, balances, and HODLMM pool access.
2. Run `analyze` to assess market conditions before committing funds.
3. If signal is "buy" with medium/high confidence → proceed to `run`.
4. If signal is "wait" or "reduce" → delay or shrink the order.
5. After `run` succeeds, use `status` to track order execution.
6. Once sBTC is acquired, run `deploy` to route into HODLMM LP.
7. Use `cancel` only if an order is stuck or conditions changed dramatically.

## Guardrails
- **NEVER bypass spend limits.** The 500 STX/order and 1000 STX/day caps are hardcoded and tracked persistently. Do not modify them.
- **NEVER run without checking analysis first** unless the user explicitly requests `--force`.
- **NEVER drain the wallet.** The 1 STX reserve is non-negotiable.
- **NEVER execute when slippage exceeds 5%.** Refuse and suggest smaller amount.
- **NEVER deploy more than 500,000 sats into HODLMM in a single call.**
- **ALWAYS confirm intent before `run` or `deploy`.** These move real funds.
- Never expose secrets or private keys in args or logs.

## HODLMM deploy behavior
- Default pool: `dlmm_1` (sBTC-USDCx). Override with `--pool`.
- Bin range: 5 bins centered on active bin (±2). This keeps liquidity in-range.
- Deploy outputs MCP instructions (`bitflow_hodlmm_add_liquidity`) — the agent framework executes the actual transaction.
- If active bin drift > 5% from last deploy, warn before proceeding.

## Interpreting analysis results

### Recommendations
- `buy` + `high`: Strong conditions. Execute at 100% of intended amount.
- `buy` + `medium`: Decent conditions. Consider 75% of intended amount.
- `wait` + `low`: Mixed signals. Skip this cycle or use 50% amount.
- `reduce` + `medium`: Negative signals. Skip or use 25% amount max.

## Integration pattern
```
1. Cron runs `analyze` every 4 hours
2. If recommendation is "buy" → run `run --amount <calculated> --to sBTC`
3. Run `status` to confirm order accepted
4. When sBTC balance increases → run `deploy --pool dlmm_1 --amount <sats>`
5. Log orderId and deploy tx for tracking
```

## On error
- Log the error payload
- Do not retry `run` silently — each retry spends funds
- Surface to user with the `action` field guidance
- On "blocked": read the error message, it explains what's wrong

## On success
- Confirm the orderId and expected output amount
- Log market conditions at time of order for post-hoc analysis
- Schedule a `status` check in 30 minutes to verify execution
- After deploy: confirm pool, bins, and amount deposited
