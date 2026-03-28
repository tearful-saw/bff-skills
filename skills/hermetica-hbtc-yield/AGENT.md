---
name: hermetica-hbtc-yield-agent
skill: hermetica-hbtc-yield
description: "Agent behavior rules for the Hermetica hBTC Yield Manager — autonomous sBTC yield via Hermetica vault on Stacks."
---

# Agent Behavior — Hermetica hBTC Yield Manager

## Decision order

1. Run `doctor` first. If any check fails, stop and surface the blocker.
2. Run `status` to understand current position before any write action.
3. For deposits: confirm intent, verify amount is within safety limits (max 50,000 sats), then execute `deposit`.
4. For withdrawals: run `request-redeem` first, note the cooldown period, then run `redeem` after cooldown expires.
5. Parse JSON output and route on `status` field (`ok` or `error`).

## Commands reference

| Command | Type | Description |
|---|---|---|
| `doctor` | read-only | Environment and wallet readiness check |
| `status` | read-only | Current position, APY, share price, pending claims |
| `deposit --amount <sats>` | write | Deposit sBTC into hBTC vault (max 50,000 sats) |
| `request-redeem --shares <amount> [--express]` | write | Request withdrawal with cooldown |
| `redeem --claim-id <id>` | write | Collect sBTC after cooldown |

## Guardrails

- **Never deposit more than 50,000 sats** in a single transaction. The code enforces this, but the agent should also validate before calling.
- Never proceed past an `error` status without investigating the cause and surfacing to the user.
- Never expose wallet keys, secrets, or private keys in arguments or logs.
- Always run `doctor` before first use in a session to verify wallet and vault state.
- Always run `status` before deposits to check current balance and vault capacity.
- Default to read-only operations (`doctor`, `status`) when intent is ambiguous.
- Do not retry failed write operations silently — surface the error and let the user decide.

## Yield strategy guidance

- **When to deposit**: When agent holds idle sBTC and hBTC vault APY exceeds the agent's minimum yield threshold. Current APY is ~6%.
- **When to redeem**: When agent needs sBTC for another operation, or when yield has dropped below threshold.
- **Cooldown awareness**: After `request-redeem`, the agent must wait for the cooldown period before calling `redeem`. Use `status` to check pending claims.
- **Express redemption**: Use `--express` flag only when urgency justifies the higher cost.

## Interpreting results

### doctor output
- `walletReady: true` — MCP wallet is configured and responsive.
- `sbtcBalance` — Available sBTC in sats. Must be > 0 for deposits.
- `hbtcBalance` — Current hBTC share balance. If > 0, agent has an active position.
- `depositEnabled` — Whether the vault is currently accepting deposits.
- `sharePrice` — Current hBTC/sBTC exchange rate (> 1.0 means yield has accrued).

### status output
- `positionValueSats` — Current position value in sBTC sats.
- `apyPct` — Current 7-day trailing APY from Hermetica API.
- `pendingClaims` — Array of pending redemption claims with cooldown status.
- `warnings` — Non-fatal issues (API unavailable, using cached data, etc.).

### deposit output
- `txId` — The on-chain transaction hash. Verify on explorer if needed.
- `amountSats` — Actual amount deposited.
- `expectedShares` — Estimated hBTC shares to receive.

### request-redeem output
- `txId` — Transaction hash for the redemption request.
- `claimId` — ID needed to call `redeem` later.
- `cooldownEnds` — Estimated timestamp when redemption becomes available.

### redeem output
- `txId` — Transaction hash for the final redemption.
- `sbtcReceived` — Amount of sBTC returned to wallet.

## On error

- Log the full error payload including the `command` and `data` fields.
- Do not retry write operations automatically.
- For `deposit` errors: check if vault is full (deposit cap), balance insufficient, or deposits disabled.
- For `request-redeem` errors: check if hBTC balance is sufficient.
- For `redeem` errors: check if cooldown has expired, or if claim ID is valid.
- Surface the error to the user with the `warnings` array content for context.

## On success

- For write operations: confirm the `txId` on-chain via Stacks explorer.
- After deposit: run `status` to verify the new position.
- After request-redeem: note the `claimId` and `cooldownEnds` for scheduling the `redeem` call.
- After redeem: run `status` to verify updated balances.
- Report completion with a summary of what changed.
