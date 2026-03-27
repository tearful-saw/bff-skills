# Agent Behavior -- Bitflow Liquidation Guard

## Decision order
1. Run `doctor` first. If it fails, stop and surface the blocker.
2. If `doctor` shows `btcPriceUSD: 0` or `liquidationRatio: 0`, the oracle or borrow contract may be paused -- warn the user.
3. Run `run --address <addr>` to check the position health.
4. Parse JSON output and route on `status` and `riskLevel`.
5. If `riskLevel` is `critical` or `liquidatable`, consider running `execute` to trigger auto-repay.
6. Never run `execute` without explicit user confirmation or a pre-configured automation rule.

## Guardrails
- **`doctor` and `run` are read-only.** They never submit transactions or access wallet keys.
- **`execute` builds a transaction but does NOT broadcast.** It returns the transaction parameters for a signing skill to submit.
- Never run `execute` automatically unless the agent has explicit user-granted authority to do so.
- Never proceed past a `blocked` status without explicit user confirmation.
- Never expose private keys or wallet secrets in args or logs.
- Always surface error payloads with a suggested next action.
- Default to read-only behavior when intent is ambiguous.

## Risk level interpretation

### safe (health > 2.50x)
- No action needed. Monitor periodically.
- Recommended check frequency: every 30 minutes.

### warning (health 1.80x - 2.50x)
- Position is approaching risk zone. Alert the user.
- Recommended check frequency: every 5 minutes.
- Consider whether auto-repay should be triggered.

### critical (health 1.60x - 1.80x)
- Immediate attention required. Strongly recommend triggering auto-repay.
- If user has granted automation authority, run `execute`.
- Recommended check frequency: every 1 minute.

### liquidatable (health < 1.50x)
- Position can be liquidated by anyone. Repay immediately.
- If `autoRepayAvailable` is true, run `execute` (with user confirmation).
- Otherwise, advise manual repayment or collateral addition.

## Key fields
- `healthFactor`: Ratio of collateral value to debt. Below `liquidationRatio` (1.5x) means liquidatable.
- `liquidationPrice`: BTC price at which the position becomes liquidatable.
- `priceDropToLiquidation`: Percentage BTC must fall from current price to hit liquidation.
- `yieldAccrued`: Share price appreciation since entry. Required for auto-repay to work.
- `autoRepayAvailable`: Whether trigger-repay can reduce debt (yield must have accrued).

## Integration with execution skills
The `execute` command returns transaction parameters for `trigger-repay`:
1. Read the `transaction` object from the output.
2. Pass `contractAddress`, `contractName`, `functionName`, and `functionArgs` to a signing skill.
3. The signing skill broadcasts the transaction and returns the tx hash.
4. Re-run `run` after the transaction confirms to verify the health factor improved.

## Output contract
All outputs are JSON to stdout with this envelope:

```json
{
  "status": "success | error | blocked",
  "action": "doctor | run | execute",
  "data": {},
  "error": "string or null"
}
```

`status` is always one of three values. `error` is a human-readable string when `status` is `error` or `blocked`, otherwise `null`.

## On error
- Log the error payload.
- Do not retry silently more than 3 times.
- Surface to user with the `action` field guidance.
- Common errors: Hiro API timeout (10s), contract call failure, invalid address format.

## On success
- Report the health factor and risk level.
- If position exists, always mention `liquidationPrice` and `priceDropToLiquidation`.
- If `autoRepayAvailable` is true, mention it as a potential mitigation.
- After `execute`, recommend re-checking with `run` to confirm improvement.
