---
name: bitflow-hodlmm-sniper-agent
skill: bitflow-hodlmm-sniper
description: "Agent behavior rules for the Bitflow HODLMM sniper skill."
---

# Agent Behavior -- Bitflow HODLMM Sniper

## Decision order
1. Run `doctor` first. If it fails, stop and surface the blocker.
2. If `doctor` reports `poolReadable: false`, abort -- Hiro API cannot read pool state.
3. Run `run` to analyze all pools and get LP entry recommendations.
4. Parse JSON output and route on `status`.
5. Filter results by `entryRecommendation.signal` -- only consider `enter` pools.

## Guardrails
- This skill is **read-only**. It never submits transactions or accesses wallet keys.
- Never treat IL simulations as guarantees -- they assume constant-product math and do not account for concentrated liquidity adjustments.
- Never proceed past a `blocked` status without investigating the cause.
- Default to re-running analysis before execution -- pool reserves change with every swap.
- Never expose raw contract data in user-facing messages without formatting.

## Interpreting results

### Entry signals
- `enter` + `high`: Pool has deep liquidity, strong fees, and manageable IL. Safe to enter.
- `enter` + `medium`: Pool is viable but has one weakness (shallow depth or lower fees). Enter with smaller position.
- `wait` + `low`: Mixed signals. Monitor but do not enter yet.
- `avoid`: Multiple risk factors present. Do not provide liquidity.

### Key fields
- `depthScore`: "deep" (>1M token X equivalent), "moderate" (>100K), "shallow" (>10K), "very-shallow" (<10K)
- `fees.totalFeeBps`: Sum of all swap fees in basis points. Higher = more LP income.
- `ilSimulation`: Shows IL at each price multiplier. priceMultiplier 1.25 means token Y price goes up 25%.
- `spotPrice`: Current on-chain price ratio (token X per token Y).
- `reserveX` / `reserveY`: Raw on-chain reserve values (use `reserveXHuman` / `reserveYHuman` for display).

### IL interpretation
- `ilPct: -0.62` at `priceMultiplier: 1.25` means LP loses 0.62% vs holding if Y price moves +25%.
- IL is always 0% when priceMultiplier is 1.0 (no price change).
- IL grows quadratically with price divergence. A 2x move causes ~5.7% IL.

## Integration with LP execution skills
The output feeds directly into an LP execution workflow:
1. Read the `entryRecommendation` from the top-ranked pool.
2. Use `contract` to target the correct pool for `add-liquidity`.
3. Use `spotPrice` to calculate the correct token ratio for deposit.
4. Use `ilSimulation` to set position size within the agent's risk tolerance.

## Recommended scan frequency
- Every 15 minutes for passive monitoring
- Every 5 minutes during high volatility events
- Re-scan immediately before any LP deposit to get fresh reserves

## Output contract
All outputs are JSON to stdout with this envelope:

```json
{
  "status": "success | error | blocked",
  "action": "doctor | run",
  "data": {},
  "error": "string or null"
}
```

`status` is always one of three values. `error` is a human-readable string when `status` is `error` or `blocked`, otherwise `null`.

## On error
- Log the error payload
- Do not retry silently more than 3 times
- Surface to user with the `action` field guidance
- Common errors: Hiro API timeout (10s), rate limit (50 req/min), pool contract not found

## On success
- Report the best pool and its entry signal
- If any pool has `signal: enter`, recommend LP provisioning with the IL caveat
- Always mention that reserves are snapshots and should be re-checked before execution
