# Agent Behavior — Zest Collateral Manager

## Decision order

1. Run `doctor` first. If it fails, stop and surface the blocker.
2. If `doctor` reports the reserve is not active or supply cap is reached, abort supply operations.
3. Run `status` to assess the current position before any write action.
4. For `supply`: confirm the amount is within the 50,000 sats safety limit, balance is sufficient, and gas is available.
5. For `withdraw`: confirm health factor will remain above 1.0 after withdrawal. Never withdraw if it would trigger liquidation.
6. For `claim-rewards`: confirm pending rewards are greater than zero before submitting a claim transaction.
7. Parse JSON output and route on `status` field.

## Guardrails

- **Never exceed the 50,000 sats supply limit** — this is hardcoded in the skill and cannot be overridden.
- **Never withdraw if health factor would drop below 1.0** — this protects against liquidation.
- Never proceed past an `error` status without investigating the cause.
- Never expose wallet keys, secrets, or private data in args or logs.
- Always surface error payloads with a suggested next action.
- Default to read-only behavior (`doctor`, `status`) when intent is ambiguous.
- When in doubt, run `status` before any write operation to verify current position.

## Interpreting results

### Health factor

- `> 2.0`: Safe — position has significant margin before liquidation.
- `1.5 - 2.0`: Caution — monitor closely, avoid further borrowing.
- `1.0 - 1.5`: Warning — consider repaying debt or adding collateral.
- `< 1.0`: Danger — position is at risk of liquidation. Do not withdraw.
- `Infinity / no borrows`: No debt — health factor is not applicable.

### LTV ratio

- `0%`: No borrows against collateral.
- `< 50%`: Conservative — significant borrowing room available.
- `50% - 70%`: Moderate — approaching the liquidation threshold.
- `> 70%`: High risk — close to liquidation. Reduce debt or add collateral.

### Key fields

- `suppliedSats`: Amount of sBTC supplied as collateral (in satoshis).
- `borrowBalanceSats`: Outstanding borrow balance (in satoshis).
- `healthFactor`: Ratio indicating liquidation risk. Below 1.0 = liquidation risk.
- `ltvPct`: Current loan-to-value percentage.
- `pendingRewardsSTX`: Accrued STX rewards available to claim.
- `useAsCollateral`: Whether the supplied sBTC is enabled as collateral.
- `reserveActive`: Whether the Zest sBTC reserve is accepting new deposits.
- `supplyCap`: Maximum total sBTC the reserve can hold.
- `warnings`: Array of non-fatal issues encountered. Check this to understand operational state.

## Commands reference

| Command | Action | Writes to chain |
|---|---|---|
| `doctor` | Check wallet, balances, reserve state, oracle | No |
| `status` | Show position: supplied, borrowed, health factor, rewards | No |
| `supply --amount <sats>` | Deposit sBTC as collateral (max 50,000 sats) | Yes |
| `withdraw --amount <sats>` | Withdraw sBTC collateral (health factor safe) | Yes |
| `claim-rewards` | Claim pending STX stacking rewards | Yes |

## Output contract

All outputs are JSON to stdout with this envelope:

```json
{
  "status": "ok | error",
  "command": "doctor | status | supply | withdraw | claim-rewards",
  "data": {},
  "error": "string or null"
}
```

`status` is always one of two values: `ok` or `error`. `error` is a human-readable string when `status` is `error`, otherwise absent.

## On error

- Log the error payload.
- Do not retry write operations silently — failed transactions cost gas.
- Surface to user with the `error` field guidance.
- Common errors: insufficient balance, health factor too low, supply cap exceeded, oracle stale, reserve inactive.
- Zest-specific error codes: u30002 (amount must be non-zero), u30003 (not enough collateral), u30007 (exceeded liquidity), u30020 (supply cap exceeded), u30028 (health factor below threshold).

## On success

- Confirm the on-chain result with tx hash.
- Report updated position summary (supplied, health factor, rewards).
- Log the operation timestamp for tracking.

## Recommended usage patterns

- Run `doctor` once at startup to verify environment.
- Run `status` before and after any write operation to confirm state changes.
- Supply sBTC in small increments (5,000-10,000 sats) to manage risk.
- Claim rewards periodically — they accrue from STX stacking.
- Monitor health factor if any borrows are active; keep it above 1.5.
