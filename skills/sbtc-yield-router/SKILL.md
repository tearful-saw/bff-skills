---
name: sbtc-yield-router
version: 0.1.0
description: "Cross-protocol sBTC yield optimizer that compares Bitflow HODLMM, Zest Protocol, and Hermetica, then recommends or simulates the optimal allocation."
metadata:
  author: tearful-saw
  author_agent: Elegant_Orb
  user-invocable: 'false'
  entry: sbtc-yield-router/sbtc-yield-router.ts
  commands:
    - doctor
    - scan
    - recommend
    - route
    - status
    - history
    - install-packs
---

# Overview

`sbtc-yield-router` evaluates current sBTC opportunities across Bitflow HODLMM, Zest Protocol, and Hermetica. It collects live read-only data when available, falls back to explicit heuristic estimates when upstream services are unavailable, and ranks destinations by a risk-adjusted score that balances yield, TVL, and protocol risk.

The skill is designed as an operator-facing router. It can:

- run health checks with `doctor`
- compare protocol opportunities with `scan`
- recommend a capped allocation with `recommend`
- simulate a route with `route --confirm`
- inspect tracked positions with `status`
- review prior routing decisions with `history`

# Architecture

The CLI is a single TypeScript entrypoint built on Commander.js. All command responses are emitted as JSON on stdout. Diagnostics, warnings, and Commander help are redirected to stderr.

Core workflow:

1. Read environment and local state from `~/.sbtc-yield-router-state.json`
2. Query Bitflow and Hiro read-only APIs
3. Normalize protocol APY, TVL, and risk data
4. Compute weighted scores with yield 40%, TVL 30%, risk 30%
5. Produce either a recommendation or a simulated unsigned route
6. Persist route history to `~/.sbtc-yield-router-history.json`

# Safety Limits

- `MAX_ROUTE_SBTC = 100_000` sats
- `MAX_SLIPPAGE_PCT = 0.5`
- `MIN_YIELD_EDGE_PCT = 0.5`
- `COOLDOWN_MS = 60 * 60 * 1000`
- `route` requires `--confirm`
- execution is simulation-only for MVP and never signs transactions

# Usage Examples

```bash
bun run skills/sbtc-yield-router/sbtc-yield-router.ts doctor
```

```bash
STX_ADDRESS=SP... bun run skills/sbtc-yield-router/sbtc-yield-router.ts scan
```

```bash
STX_ADDRESS=SP... bun run skills/sbtc-yield-router/sbtc-yield-router.ts recommend --amount 50000
```

```bash
STX_ADDRESS=SP... bun run skills/sbtc-yield-router/sbtc-yield-router.ts route --amount 50000 --confirm
```

```bash
STX_ADDRESS=SP... bun run skills/sbtc-yield-router/sbtc-yield-router.ts status
```

```bash
bun run skills/sbtc-yield-router/sbtc-yield-router.ts history
```

```bash
bun run skills/sbtc-yield-router/sbtc-yield-router.ts install-packs --pack all
```
