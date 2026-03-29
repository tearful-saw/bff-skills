---
name: hermetica-hbtc-yield
description: "Autonomous sBTC yield manager for Hermetica hBTC vault on Stacks — deposit, monitor, and redeem sBTC to earn Bitcoin-denominated yield at ~6% APY."
metadata:
  author: "tearful-saw"
  author-agent: "Elegant Orb"
  user-invocable: "false"
  arguments: "doctor | status | deposit | request-redeem | redeem"
  entry: "hermetica-hbtc-yield/hermetica-hbtc-yield.ts"
  requires: "wallet, signing, settings"
  tags: "defi, write, mainnet-only, l2, requires-funds"
---

# Hermetica hBTC Yield Manager

## What it does

Manages sBTC yield positions in the Hermetica hBTC vault on Stacks mainnet. Deposits sBTC into the vault to mint hBTC shares that accrue Bitcoin-denominated yield (~6% APY). Monitors position value, share price, and vault state. Handles the two-step redemption flow (request-redeem then redeem after cooldown). All operations interact with Hermetica's on-chain contracts via the AIBTC MCP wallet.

## Why agents need it

sBTC sitting idle in a wallet earns nothing. Hermetica's hBTC vault is the first live Bitcoin-yield protocol on Stacks, offering ~6% APY on sBTC deposits. This skill lets an autonomous agent put sBTC to work, monitor the growing position, and exit when needed — all without manual intervention. It is the first BFF skill to cover the Hermetica protocol, giving agents access to a yield source no other skill provides.

## Safety notes

- **Writes to chain**: `deposit`, `request-redeem`, and `redeem` commands submit transactions.
- **Moves funds**: Deposits transfer sBTC from wallet to vault; redemptions return sBTC.
- **Mainnet only**: All contracts are on Stacks mainnet.
- **Hardcoded deposit cap**: Maximum single deposit is 50,000 sats (0.0005 BTC), enforced in code.
- **Two-step withdrawal**: `request-redeem` initiates a cooldown; `redeem` collects after cooldown expires. Express redemption available at higher cost.
- **Irreversible**: Once a deposit tx confirms, funds are in the vault until redeemed.

## On-chain proof

Mainnet deposit tx: [`b51f08cbfb1b12cf1131b5fe21d1f70b9bc6f16198ae4f0f945d299fa6f921dc`](https://explorer.hiro.so/txid/0xb51f08cbfb1b12cf1131b5fe21d1f70b9bc6f16198ae4f0f945d299fa6f921dc?chain=mainnet) — 10,000 sats sBTC deposited into hBTC vault.

## Hermetica contracts (deployer: SP1S1HSFH0SQQGWKB69EYFNY0B1MHRMGXR3J1FH4D)

| Contract | Role |
|---|---|
| `vault-hbtc-v1` | Core vault: deposit, request-redeem, redeem, cancel-redeem |
| `token-hbtc` | hBTC SIP-010 token (8 decimals) |
| `state-hbtc-v1` | Read-only state: share price, deposit cap, total assets |
| `reserve-hbtc-v1` | Holds sBTC reserves |

sBTC token: `SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token`

## Commands

### doctor

Checks AIBTC wallet availability, sBTC balance, hBTC balance, vault deposit state, and share price. Safe to run anytime — read-only.

```bash
bun run hermetica-hbtc-yield/hermetica-hbtc-yield.ts doctor
```

### status

Shows current hBTC position, share price, sBTC value, USD value estimate, and live APY from Hermetica API. Read-only.

```bash
bun run hermetica-hbtc-yield/hermetica-hbtc-yield.ts status
```

### deposit

Deposit sBTC into the hBTC vault. Enforces a hardcoded maximum of 50,000 sats per deposit. Pre-flight checks: balance sufficiency, gas availability, deposit-enabled state.

```bash
bun run hermetica-hbtc-yield/hermetica-hbtc-yield.ts deposit --amount 10000
```

### request-redeem

Request withdrawal of hBTC shares. Initiates a cooldown period. Use `--express` for faster redemption (higher cost).

```bash
bun run hermetica-hbtc-yield/hermetica-hbtc-yield.ts request-redeem --shares 10000 --express
```

### redeem

Collect sBTC after cooldown has expired. Requires the claim ID from the request-redeem step.

```bash
bun run hermetica-hbtc-yield/hermetica-hbtc-yield.ts redeem --claim-id 1
```

## Output contract

All outputs are JSON to stdout. Diagnostic logs go to stderr.

**Success (read-only commands):**
```json
{
  "status": "ok",
  "command": "status",
  "data": { "hbtcBalanceShares": 10000, "sharePrice": 1.002, "..." : "..." }
}
```

**Success (write commands):**
Write commands emit an `mcpCommand` payload. The calling agent must invoke the MCP `contract-call` tool with those arguments to actually submit the transaction.
```json
{
  "status": "ok",
  "command": "deposit",
  "data": {
    "action": "execute-contract-call",
    "contractCall": { "contractAddress": "...", "contractName": "vault-hbtc-v1", "functionName": "deposit", "functionArgs": ["..."], "postConditions": ["..."] },
    "humanReadable": { "description": "Deposit 10000 sats...", "amountSats": 10000 },
    "mcpCommand": { "tool": "contract-call", "args": { "contract": "...", "function": "deposit", "arguments": ["u10000", "none"] } },
    "warnings": []
  }
}
```

**Error:**
```json
{
  "status": "error",
  "command": "deposit",
  "data": null,
  "error": "Insufficient sBTC balance: have 5000, need 10000"
}
```

## Known constraints

- Mainnet only — Hermetica hBTC vault is deployed on Stacks mainnet.
- Requires sBTC in wallet for deposits and STX for gas fees.
- Maximum deposit per transaction: 50,000 sats (hardcoded safety limit).
- Redemption has a cooldown period — not instant unless express mode is used.
- Share price and APY are fetched from Hermetica API; if API is down, cached/on-chain values are used as fallback.
- hBTC uses 8 decimal places (same as sBTC).
- Vault may have a deposit cap; skill checks this before attempting deposit.
