---
name: bitflow-smart-dca-v2
description: "Market-aware DCA into sBTC via Bitflow Keeper with optional HODLMM LP deployment and persistent spend tracking."
metadata:
  author: "tearful-saw"
  author-agent: "Elegant Orb"
  user-invocable: "false"
  arguments: "doctor | analyze | run | status | cancel | deploy"
  entry: "bitflow-smart-dca-v2/bitflow-smart-dca-v2.ts"
  requires: "wallet, signing, settings"
  tags: "defi, write, mainnet-only, requires-funds, l2"
---

# Bitflow Smart DCA v2

## What it does
Automates Dollar-Cost Averaging into sBTC via Bitflow Keeper, then optionally deploys acquired sBTC into HODLMM liquidity pools. Before each order it analyzes on-chain conditions — BTC fees, mempool congestion, hashrate, difficulty — and recommends whether to buy, wait, or reduce. A persistent daily spend ledger enforces the daily cap across runs. The new `deploy` command routes DCA output into HODLMM LP bins for passive fee income.

## Why agents need it
Autonomous agents holding STX need a disciplined accumulation path into sBTC that doesn't stop at the swap. This skill closes the loop: analyze → buy → deploy into HODLMM LP → earn fees. The Keeper handles async execution, the spend ledger prevents overspend across restarts, and HODLMM deployment puts idle sBTC to work.

## Safety notes
- **Writes to chain**: Creates Keeper swap orders and HODLMM LP deposits. Funds are committed on execution.
- **Hard spend limits**: Max 500 STX per order, 1000 STX per day. Tracked persistently in `~/.bitflow-smart-dca-spend.json` — survives restarts.
- **Slippage guard**: Refuses if estimated slippage exceeds 5%.
- **Balance reserve**: Always keeps 1 STX for gas — will not drain the wallet.
- **Market kill-switch**: Blocks execution when multiple negative signals detected (override with `--force`).
- **HODLMM deploy limits**: Max 500,000 sats per deploy, 0.5% max slippage on LP entry.
- **Mainnet only**: Bitflow Keeper and HODLMM are not available on testnet.

## Commands

### doctor
Check wallet, Keeper API, HODLMM pool access, balances, and safety configuration.
```bash
STX_ADDRESS=SP... bun run bitflow-smart-dca-v2/bitflow-smart-dca-v2.ts doctor
```

### analyze
Assess current market conditions for DCA timing. Read-only.
```bash
STX_ADDRESS=SP... bun run bitflow-smart-dca-v2/bitflow-smart-dca-v2.ts analyze
```

### run
Create a DCA order. Runs analysis first, checks daily spend ledger, then submits via Keeper.
```bash
STX_ADDRESS=SP... bun run bitflow-smart-dca-v2/bitflow-smart-dca-v2.ts run --amount 10 --to sBTC
STX_ADDRESS=SP... bun run bitflow-smart-dca-v2/bitflow-smart-dca-v2.ts run --amount 10 --to sBTC --force
```

### deploy
Route sBTC into a HODLMM LP position. Reads current pool state, picks bins around the active bin, and outputs MCP deposit instructions.
```bash
STX_ADDRESS=SP... bun run bitflow-smart-dca-v2/bitflow-smart-dca-v2.ts deploy --pool dlmm_1 --amount 50000
```

### status
Check existing Keeper contracts, order history, and HODLMM LP positions.
```bash
STX_ADDRESS=SP... bun run bitflow-smart-dca-v2/bitflow-smart-dca-v2.ts status
```

### cancel
Cancel a pending Keeper order.
```bash
bun run bitflow-smart-dca-v2/bitflow-smart-dca-v2.ts cancel --order-id <id>
```

## Output contract

All outputs are JSON to stdout.

**Success:**
```json
{ "status": "success", "action": "run", "data": { "orderId": "...", "amountIn": 10 }, "error": null }
```

**Error:**
```json
{ "status": "error", "action": "run", "data": null, "error": "descriptive message" }
```

**Blocked:**
```json
{ "status": "blocked", "action": "run", "data": { "hint": "..." }, "error": "reason execution was blocked" }
```

## Known constraints
- Mainnet only (Bitflow Keeper and HODLMM not on testnet)
- Keeper orders are asynchronous — execution time depends on Keeper service
- Market analysis uses Bitcoin L1 signals only (no price oracle)
- HODLMM deploy outputs MCP instructions — requires agent framework with `bitflow_hodlmm_add_liquidity` tool
- Daily spend ledger resets at 00:00 UTC
