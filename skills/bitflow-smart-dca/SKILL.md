---
name: bitflow-smart-dca
description: Intelligent Dollar-Cost Averaging via Bitflow Keeper — analyzes on-chain conditions, enforces spend limits, and automates recurring swaps with kill-switch guards.
author: 0q_bulletproof
author_agent: Elegant Orb
user-invocable: true
arguments: doctor | analyze | run --from STX --to sBTC --amount 10 | status | cancel --order-id <id>
entry: bitflow-smart-dca/bitflow-smart-dca.ts
requires: [wallet]
tags: [defi, write, mainnet-only, requires-funds, l2]
---

# Bitflow Smart DCA

## What it does
Automates Dollar-Cost Averaging into Bitcoin (sBTC) or other Stacks tokens using Bitflow's Keeper infrastructure. Before each order, it analyzes on-chain conditions — BTC fee rates, mempool congestion, hashrate, difficulty adjustments — and recommends whether to buy, wait, or reduce position size. Orders execute through Bitflow Keeper with hard-coded safety limits.

## Why agents need it
Autonomous agents holding STX need a disciplined way to accumulate sBTC without emotional trading. This skill replaces "swap whenever" with data-driven timing: it reads the chain, sizes the position, and refuses to execute when conditions are hostile. The Keeper handles execution so the agent doesn't need to stay online.

## Safety notes
- **Writes to chain**: Creates Keeper orders that execute swaps. Funds are committed.
- **Hard spend limits**: Max 500 STX per order, 1000 STX per day. Non-negotiable.
- **Slippage guard**: Refuses if estimated slippage exceeds 5%.
- **Balance reserve**: Always keeps 1 STX for gas — will not drain the wallet.
- **Market kill-switch**: Blocks execution when multiple negative signals detected (override with `--force`).
- **Mainnet only**: Bitflow Keeper is not available on testnet.

## Commands

### doctor
Check wallet, Keeper API connectivity, balances, and safety configuration.
```bash
STX_ADDRESS=SP... bun run bitflow-smart-dca/bitflow-smart-dca.ts doctor
```

### analyze
Assess current market conditions for DCA timing. Read-only — no orders created.
```bash
STX_ADDRESS=SP... bun run bitflow-smart-dca/bitflow-smart-dca.ts analyze
```

### run
Create a DCA order. Runs analysis first, then submits via Keeper.
```bash
STX_ADDRESS=SP... bun run bitflow-smart-dca/bitflow-smart-dca.ts run --from STX --to sBTC --amount 10
STX_ADDRESS=SP... bun run bitflow-smart-dca/bitflow-smart-dca.ts run --from STX --to sBTC --amount 10 --force
```

### status
Check existing Keeper contracts and order history.
```bash
STX_ADDRESS=SP... bun run bitflow-smart-dca/bitflow-smart-dca.ts status
```

### cancel
Cancel a pending Keeper order.
```bash
bun run bitflow-smart-dca/bitflow-smart-dca.ts cancel --order-id <id>
```

## Output contract
```json
{
  "status": "success | error | blocked",
  "action": "doctor | analyze | run | status | cancel",
  "data": {},
  "error": null
}
```

## Known constraints
- Mainnet only (Bitflow Keeper not on testnet)
- Keeper orders are asynchronous — execution time depends on Keeper service
- Market analysis uses Bitcoin L1 signals only (no price oracle)
- Token aliases limited to STX, sBTC, WELSH, ALEX — use full Bitflow token IDs for others
