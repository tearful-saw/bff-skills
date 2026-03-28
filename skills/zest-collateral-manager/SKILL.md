---
name: zest-collateral-manager
description: "Autonomous sBTC collateral manager for Zest Protocol on Stacks — supply, withdraw, monitor health factor, and claim STX rewards from lending positions."
metadata:
  author: "tearful-saw"
  author-agent: "Elegant Orb"
  user-invocable: "false"
  arguments: "doctor | status | supply | withdraw | claim-rewards"
  entry: "zest-collateral-manager/zest-collateral-manager.ts"
  requires: "wallet, signing, settings"
  tags: "defi, write, mainnet-only, l2, requires-funds"
---

# Zest Collateral Manager

## What it does

Manages sBTC collateral positions on Zest Protocol, the leading lending market on Stacks mainnet. Supplies sBTC as collateral to mint zsBTC receipt tokens, monitors position health factor and loan-to-value ratios, withdraws collateral safely with liquidation-threshold checks, and claims accrued STX stacking rewards. All operations interact with Zest's on-chain contracts via the AIBTC MCP wallet.

## Why agents need it

sBTC sitting idle in a wallet earns nothing. Zest Protocol lets agents deposit sBTC as collateral to earn STX stacking rewards while maintaining borrowing power. This skill gives agents full collateral lifecycle management — deposit, monitor, withdraw, and claim — with built-in safety rails that prevent liquidation. It is the first BFF skill to cover the borrow-side of Zest Protocol, unlocking health-factor-aware position management that no other skill provides.

## Safety notes

- **Writes to chain**: `supply`, `withdraw`, and `claim-rewards` commands submit transactions.
- **Moves funds**: Supply transfers sBTC from wallet to Zest reserve; withdraw returns sBTC.
- **Mainnet only**: All contracts are on Stacks mainnet.
- **Hardcoded supply cap**: Maximum single supply is 50,000 sats (0.0005 BTC), enforced in code.
- **Health factor checks**: Withdraw verifies the resulting health factor stays above 1.0 to prevent liquidation.
- **Irreversible**: Once a supply tx confirms, funds are in the Zest reserve until withdrawn.

## On-chain proof

Mainnet supply tx: [`6562723433c87038c19ad569fe3a6a5fd022ec1d29648a66f0b27e02c63e96b0`](https://explorer.hiro.so/txid/0x6562723433c87038c19ad569fe3a6a5fd022ec1d29648a66f0b27e02c63e96b0?chain=mainnet) — 5,000 sats sBTC supplied to Zest as collateral.

## Zest Protocol contracts (deployer: SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N)

| Contract | Role |
|---|---|
| `borrow-helper-v2-1-7` | Main entry point: supply, withdraw, borrow, repay, claim-rewards |
| `zsbtc-v2-0` | sBTC z-token (receipt token for supplied collateral) |
| `pool-0-reserve-v2-0` | Reserve data: user positions, health factor, reserve state |
| `incentives-v2-2` | Stacking rewards: pending STX rewards for suppliers |
| `stx-btc-oracle-v1-4` | Price oracle for STX/BTC |

sBTC token: `SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token`

## Commands

### doctor

Checks AIBTC wallet availability, STX gas balance, sBTC balance, zsBTC balance, Zest reserve state (active, supply cap, LTV), and oracle status. Safe to run anytime — read-only.

```bash
bun run zest-collateral-manager/zest-collateral-manager.ts doctor
```

### status

Shows current collateral position: supplied amount (zsBTC), collateral value in sats, borrow balance, health factor, LTV ratio, pending STX rewards, and collateral-enabled state. Read-only.

```bash
bun run zest-collateral-manager/zest-collateral-manager.ts status
```

### supply

Supply sBTC as collateral to Zest Protocol. Enforces a hardcoded maximum of 50,000 sats per transaction. Pre-flight checks: sBTC balance sufficiency, STX gas availability, reserve active state, supply cap not exceeded.

```bash
bun run zest-collateral-manager/zest-collateral-manager.ts supply --amount 5000
```

### withdraw

Withdraw sBTC collateral from Zest Protocol. Pre-flight checks: sufficient supplied balance, health factor will remain above 1.0 after withdrawal (prevents liquidation).

```bash
bun run zest-collateral-manager/zest-collateral-manager.ts withdraw --amount 5000
```

### claim-rewards

Claim pending STX stacking rewards accrued from supplying sBTC collateral. Pre-flight check: rewards must be greater than zero.

```bash
bun run zest-collateral-manager/zest-collateral-manager.ts claim-rewards
```

## Output contract

All outputs are JSON to stdout. Diagnostic logs go to stderr.

**Success:**
```json
{
  "status": "ok",
  "command": "supply",
  "data": {
    "txId": "0xabc...",
    "amountSats": 5000,
    "warnings": []
  }
}
```

**Error:**
```json
{
  "status": "error",
  "command": "supply",
  "data": null,
  "error": "Insufficient sBTC balance: have 3000 sats, need 5000 sats"
}
```

## Known constraints

- Mainnet only — Zest Protocol is deployed on Stacks mainnet.
- Requires sBTC in wallet for supply and STX for gas fees (~0.5 STX per tx).
- Maximum supply per transaction: 50,000 sats (hardcoded safety limit).
- Withdraw checks health factor to prevent liquidation — withdrawal blocked if it would drop below 1.0.
- zsBTC uses 8 decimal places (same as sBTC).
- Oracle price feeds are required for withdraw and claim-rewards; if oracle is stale, operations may fail.
- Supply cap is enforced by the protocol — skill checks this before attempting supply.
- Error codes: u30002 (not zero), u30003 (not enough collateral), u30007 (exceeded liquidity), u30020 (supply cap exceeded), u30028 (health factor below threshold).
