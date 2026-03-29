---
name: bitflow-liquidation-guard
description: "Zest Protocol liquidation monitoring and auto-repay builder"
metadata:
  author: "0q_bulletproof"
  author-agent: "Elegant Orb"
  user-invocable: "false"
  arguments: "doctor | run | execute"
  entry: "bitflow-liquidation-guard/bitflow-liquidation-guard.ts"
  requires: ""
  tags: "write, defi, l2, mainnet-only, requires-funds"
---

# Bitflow Liquidation Guard

## What it does
Reads on-chain borrow positions from Zest Protocol's Stacky contracts via Hiro API read-only calls. For a given Stacks address, it retrieves the collateral shares, debt amount, strategy type, and current share/BTC prices from the oracle. It calculates the real-time health factor, determines the BTC price at which liquidation would occur, and classifies risk level (safe/warning/critical/liquidatable). In execute mode, it builds a `trigger-repay` transaction that uses accrued yield to automatically pay down debt.

## Why agents need it
Autonomous DeFi agents managing leveraged positions on Zest/Stacky need real-time liquidation monitoring. Without this, a sudden BTC price drop can liquidate a position before the agent reacts. This skill gives the agent a structured health assessment with clear action thresholds, and provides the transaction data needed to trigger yield-based auto-repayment -- reducing debt without requiring the user to deposit additional funds.

## Safety notes
- **Read commands (`doctor`, `run`) are read-only**: no transactions, no wallet access.
- **`execute` builds a transaction but does NOT broadcast it**: it returns transaction parameters for a signing skill or wallet to submit. The agent or user must explicitly sign.
- The `trigger-repay` contract function is permissionless -- anyone can call it for any user. It does not move user funds; it converts accrued yield into debt repayment.
- Mainnet only (Stacky contracts are deployed on Stacks mainnet).
- All contract reads timeout after 10 seconds.
- 300ms delay between API calls to respect Hiro rate limits.

## Commands

### doctor
Checks Hiro API connectivity and reads all Zest Protocol parameters: BTC price, liquidation ratio, max LTV, min borrow, total borrowed, vault TVL, and share prices for all strategies (Zest, Granite, Hermetica).

```bash
bun run bitflow-liquidation-guard/bitflow-liquidation-guard.ts doctor
```

### run
Monitors a specific address for liquidation risk. Reads the borrow position, current prices, and calculates health factor.

```bash
bun run bitflow-liquidation-guard/bitflow-liquidation-guard.ts run --address SP1234...
```

### execute
Triggers yield-based auto-repay for a position. Returns the transaction data needed for signing. Only works if yield has accrued (share price > entry price).

```bash
bun run bitflow-liquidation-guard/bitflow-liquidation-guard.ts execute --address SP1234...
```

## Output contract
All outputs are JSON to stdout. Diagnostic logs go to stderr.

### doctor output
```json
{
  "status": "success",
  "action": "doctor",
  "data": {
    "hiro": { "reachable": true },
    "contracts": {
      "borrow": "SPCG3TNZXGFP36E4QGQN92TBM3JYF7E4PHGGR120.stacky-borrow",
      "vault": "SPCG3TNZXGFP36E4QGQN92TBM3JYF7E4PHGGR120.stacky-vault",
      "oracle": "SPCG3TNZXGFP36E4QGQN92TBM3JYF7E4PHGGR120.stacky-oracle",
      "governance": "SPCG3TNZXGFP36E4QGQN92TBM3JYF7E4PHGGR120.stacky-governance"
    },
    "protocol": {
      "btcPriceUSD": 70436,
      "liquidationRatio": 1.5,
      "maxLTV": 0.5,
      "minBorrowUSD": 1,
      "totalBorrowedUSD": 0,
      "vaultTVL": "0"
    },
    "strategies": { "Zest": 1, "Granite": 1, "Hermetica": 1 },
    "riskThresholds": { "critical": 1.6, "warning": 1.8, "safe": 2.5 },
    "commands": [
      "doctor",
      "run --address <STX_ADDRESS>",
      "execute --address <STX_ADDRESS> (triggers yield auto-repay)"
    ]
  },
  "error": null
}
```

### run output (no position)
```json
{
  "status": "success",
  "action": "run",
  "data": {
    "address": "SP3FBR2AGK5H9QBDH3EEN6DF8EK8JY7RX8QJ5SVTE",
    "hasPosition": false,
    "recommendation": "No borrow position found for this address.",
    "btcPriceUSD": 0
  },
  "error": null
}
```

### run output (with position)
```json
{
  "status": "success",
  "action": "run",
  "data": {
    "address": "SP1EXAMPLE...",
    "hasPosition": true,
    "position": {
      "strategy": 1,
      "strategyName": "Zest",
      "collateralShares": "50000000",
      "entrySharePrice": 1.0,
      "debtUSD": 15000,
      "lastRepayHeight": "185000"
    },
    "currentSharePrice": 1.02,
    "btcPriceUSD": 70436,
    "collateralValueUSD": 35720.32,
    "healthFactor": 2.3814,
    "liquidationRatio": 1.5,
    "riskLevel": "safe",
    "liquidationPrice": 44350.00,
    "priceDropToLiquidation": 37.03,
    "yieldAccrued": 0.02,
    "autoRepayAvailable": true,
    "recommendation": "Position is healthy. Continue monitoring periodically."
  },
  "error": null
}
```

### execute output
```json
{
  "status": "success",
  "action": "execute",
  "data": {
    "action": "trigger-repay",
    "description": "Triggers yield-based auto-repay on the Stacky borrow contract.",
    "healthBefore": 1.62,
    "riskLevel": "critical",
    "yieldAccrued": 0.015,
    "transaction": {
      "contractAddress": "SPCG3TNZXGFP36E4QGQN92TBM3JYF7E4PHGGR120",
      "contractName": "stacky-borrow",
      "functionName": "trigger-repay",
      "functionArgs": [{ "type": "principal", "value": "SP1EXAMPLE..." }],
      "postConditions": [],
      "note": "This transaction requires a wallet signature."
    },
    "warning": "This will submit an on-chain transaction. Ensure the signing wallet has STX for gas fees (~0.01 STX)."
  },
  "error": null
}
```

## Known constraints
- Mainnet only (Stacky/Zest contracts on Stacks mainnet)
- Requires a valid Stacks address (SP...) to check position
- The `execute` command builds transaction data but does NOT broadcast -- a separate signing skill is needed
- BTC price comes from the Stacky on-chain oracle, which may have a small lag vs real-time feeds
- The `trigger-repay` function is permissionless but only works when share price > entry price (yield must have accrued)
- Protocol currently shows 0 TVL / 0 borrowed -- positions will appear when users begin borrowing
- All Hiro API calls timeout after 10 seconds
- 300ms delay between contract reads to stay within free-tier rate limits
- Health factor uses 8-decimal fixed-point math (ONE_8 = 100000000)
