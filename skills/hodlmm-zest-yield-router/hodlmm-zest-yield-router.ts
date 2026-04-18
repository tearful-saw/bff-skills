#!/usr/bin/env bun
/**
 * hodlmm-zest-yield-router — autonomous capital allocator between HODLMM LP
 * and Zest Protocol sBTC supply.
 *
 * Closes the "no idle capital, pick the best rate" loop for sBTC-paired
 * HODLMM positions. Compares live HODLMM pool APR against Zest sBTC supply
 * APY, applies hysteresis + dwell-time + cost-amortization, and emits a
 * machine-readable execution plan that composes with `hodlmm-move-liquidity`
 * and `zest-yield-manager` per #483 composition rules.
 *
 * v1 scope: decision engine + planner (no direct writes). Execution is
 * delegated to the downstream write skills named in the plan. This respects
 * #483 (don't bundle — compose via CLI) and keeps the router auditable.
 *
 * Commands:
 *   doctor   — env + API + wallet + pool checks
 *   scan     — snapshot live APYs from both protocols into local state
 *   decide   — apply decision rules (hysteresis + dwell + cost)
 *   plan     — emit execution plan (CLIs to invoke downstream)
 *   run      — scan + decide + plan in one cycle (no writes without --confirm)
 *   status   — show current state + last decision
 *   history  — past decisions
 *   install-packs — lists required dependent skills
 */

import { Command } from "commander";
import { readFileSync, writeFileSync, existsSync, renameSync } from "fs";
import { randomBytes } from "crypto";
import { join } from "path";
import { homedir } from "os";
import {
  contractPrincipalCV,
  fetchCallReadOnlyFunction,
  cvToJSON,
} from "@stacks/transactions";
import { STACKS_MAINNET } from "@stacks/network";

// ─── Config ──────────────────────────────────────────────────────────────
const HODLMM_APP_API = "https://bff.bitflowapis.finance/api/app/v1";

// Zest mainnet — mirrors zest-yield-manager (@secret-mars)
const ZEST_POOL_RESERVE = "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.pool-0-reserve-v2-0";
const SBTC_TOKEN = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";
// STX token contract ID used by bitflow swap (human-readable-alias-insensitive).
const STX_TOKEN = "SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.token-stx-v-1-2";

const STATE_PATH =
  process.env.HODLMM_ZEST_ROUTER_STATE ||
  join(homedir(), ".hodlmm-zest-yield-router.json");

// Defaults for decision knobs (all overridable via CLI)
const DEFAULT_ENTER_ZEST_GAP_PCT = 3.0; // HODLMM APR must be below Zest by this much to switch to Zest
const DEFAULT_ENTER_HODLMM_GAP_PCT = 2.0; // HODLMM must be above Zest by this to switch back
const DEFAULT_MIN_DWELL_HOURS = 24;
const DEFAULT_ROUND_TRIP_COST_PCT = 0.5; // one full switch costs ~0.5% of capital (gas + slippage)
const DEFAULT_EXPECTED_DWELL_DAYS = 7; // how long we expect to stay at new allocation
const MAX_HISTORY = 500;

// Zest V2 uses an 8-decimal scale for `current-liquidity-rate` (annualized APR).
// Empirically verified against USDh (rate ≈ 4,008,099 → ~4% APR), stSTX, sBTC.
// This is NOT AAVE's ray (10^27) — Zest stores rates in a compact fixed-point.
const ZEST_RATE_SCALE = 1e8;

// ─── Types ───────────────────────────────────────────────────────────────
type Mode = "hodlmm" | "zest" | "unknown";
type OutputStatus = "success" | "error" | "blocked";
type Decision = "switch_to_zest" | "switch_to_hodlmm" | "stay";

interface HodlmmPoolDetail {
  poolId: string;
  poolContract: string;
  poolStatus: boolean;
  tokens: {
    tokenX: { contract: string; symbol: string; decimals: number };
    tokenY: { contract: string; symbol: string; decimals: number };
  };
  apr?: number;
  apr24h?: number;
  tvlUsd?: number;
  volumeUsd1d?: number;
  feesUsd1d?: number;
}

interface RateSnapshot {
  ts: string;
  hodlmm_apr_pct: number;
  hodlmm_apr24h_pct: number;
  zest_supply_apy_pct: number;
  zest_borrow_apy_pct: number;
  zest_rate_raw: string;
  hodlmm_pool_id: string;
  hodlmm_tvl_usd: number | null;
  hodlmm_volume_usd_1d: number | null;
}

interface DecisionRecord {
  ts: string;
  decision: Decision;
  current_mode: Mode;
  hodlmm_apr_pct: number;
  zest_apy_pct: number;
  gap_pct: number;
  threshold_pct: number;
  dwell_ok: boolean;
  hours_since_last_switch: number | null;
  cost_model: {
    round_trip_cost_pct: number;
    expected_dwell_days: number;
    net_benefit_pct: number;
  };
  reason: string;
}

interface PoolState {
  current_mode: Mode;
  last_switched_at: string | null;
  last_scan: RateSnapshot | null;
  last_decision: DecisionRecord | null;
  history: DecisionRecord[];
}

interface RouterState {
  version: 1;
  pools: Record<string, PoolState>;
}

interface PlanStep {
  order: number;
  action: string;
  description: string;
  invocation:
    | { type: "cli"; skill: string; command: string; args: string[] }
    | { type: "contract"; contract: string; function: string; args: string[] }
    | { type: "user-confirm"; prompt: string };
}

interface OutputEnvelope {
  status: OutputStatus;
  action: string;
  data: unknown;
  error: { code: string; message: string; next?: string } | null;
}

// ─── IO ─────────────────────────────────────────────────────────────────
function output(payload: OutputEnvelope): void {
  console.log(JSON.stringify(payload));
}

function log(...args: unknown[]): void {
  console.error("[yield-router]", ...args);
}

function loadState(): RouterState {
  if (!existsSync(STATE_PATH)) return { version: 1, pools: {} };
  try {
    const raw = readFileSync(STATE_PATH, "utf8");
    const parsed = JSON.parse(raw) as RouterState;
    if (!parsed.pools) return { version: 1, pools: {} };
    return parsed;
  } catch (e) {
    log(`state load failed: ${(e as Error).message}`);
    return { version: 1, pools: {} };
  }
}

function saveState(state: RouterState): void {
  // Atomic write: per-process unique tmp → rename. The unique suffix prevents
  // concurrent writers (cron `run` + manual `decide`/`set-mode`) from clobbering
  // each other's in-flight tmp file, which would either swap the wrong payload
  // in via rename or trip ENOENT on the losing rename. Full lost-update races
  // across independent load/mutate/save cycles still need an external lock;
  // this fix only covers the tmp-file collision.
  const tmp = `${STATE_PATH}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, STATE_PATH);
}

function ensurePoolState(state: RouterState, poolId: string): PoolState {
  if (!state.pools[poolId]) {
    state.pools[poolId] = {
      current_mode: "unknown",
      last_switched_at: null,
      last_scan: null,
      last_decision: null,
      history: [],
    };
  }
  return state.pools[poolId];
}

// ─── HTTP helpers ───────────────────────────────────────────────────────
async function fetchJson<T>(url: string, timeoutMs = 15_000): Promise<T> {
  let resp: Response;
  try {
    resp = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new Error(`network error ${url}: ${(e as Error).message}`);
  }
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} for ${url}`);
  }
  try {
    return (await resp.json()) as T;
  } catch (e) {
    throw new Error(`parse error ${url}: ${(e as Error).message}`);
  }
}

async function fetchHodlmmPool(poolId: string): Promise<HodlmmPoolDetail> {
  return fetchJson<HodlmmPoolDetail>(`${HODLMM_APP_API}/pools/${poolId}`);
}

// ─── Zest read ──────────────────────────────────────────────────────────
function splitContractId(id: string): { address: string; name: string } {
  const [address, name] = id.split(".");
  return { address, name };
}

async function fetchZestSupplyApy(): Promise<{
  supply_apy_pct: number;
  borrow_apy_pct: number;
  raw_rate: string;
}> {
  const { address, name } = splitContractId(ZEST_POOL_RESERVE);
  const { address: sbtcAddr, name: sbtcName } = splitContractId(SBTC_TOKEN);
  const result = await fetchCallReadOnlyFunction({
    network: STACKS_MAINNET,
    contractAddress: address,
    contractName: name,
    functionName: "get-reserve-state",
    functionArgs: [contractPrincipalCV(sbtcAddr, sbtcName)],
    senderAddress: address,
  });
  // cvToJSON shapes: `(ok (tuple ...))` → { success: true, value: { value: tuple } }
  //                  `(err ...)`         → { success: false, value: ... }
  //                  bare `(tuple ...)`  → { value: tuple } (no success key)
  // Walk to the tuple body robustly and fail loudly if the rate field is missing.
  const json = cvToJSON(result) as {
    success?: boolean;
    value?: unknown;
  };
  if (json?.success === false) {
    throw new Error(`Zest reserve-state returned (err ...): ${JSON.stringify(json)}`);
  }
  // Unwrap one or two levels until we find an object containing `current-liquidity-rate`.
  let body = json?.value as Record<string, { value?: string }> | undefined;
  const hasRate = (x: unknown): boolean =>
    typeof x === "object" && x !== null && "current-liquidity-rate" in (x as object);
  if (!hasRate(body)) {
    const inner = (body as { value?: unknown } | undefined)?.value;
    if (hasRate(inner)) body = inner as Record<string, { value?: string }>;
  }
  if (!hasRate(body)) {
    throw new Error(
      `Zest reserve-state parse: no current-liquidity-rate found in response body: ${JSON.stringify(json).slice(0, 500)}`,
    );
  }
  const v = body as Record<string, { value?: string }>;
  let rateRaw: string;
  let borrowRaw: string;
  try {
    rateRaw = String(v["current-liquidity-rate"]?.value ?? "0");
    borrowRaw = String(v["current-variable-borrow-rate"]?.value ?? "0");
    // Validate they parse as BigInt; empty/malformed strings throw here rather
    // than produce silent NaN downstream.
    void BigInt(rateRaw);
    void BigInt(borrowRaw);
  } catch (e) {
    throw new Error(`Zest reserve-state numeric parse failed: ${(e as Error).message}`);
  }
  const supplyApr = Number(BigInt(rateRaw)) / ZEST_RATE_SCALE;
  const borrowApr = Number(BigInt(borrowRaw)) / ZEST_RATE_SCALE;
  return {
    supply_apy_pct: Number((supplyApr * 100).toFixed(4)),
    borrow_apy_pct: Number((borrowApr * 100).toFixed(4)),
    raw_rate: rateRaw,
  };
}

// ─── Decision engine ────────────────────────────────────────────────────
interface DecisionKnobs {
  enter_zest_gap_pct: number;
  enter_hodlmm_gap_pct: number;
  min_dwell_hours: number;
  round_trip_cost_pct: number;
  expected_dwell_days: number;
}

function decide(
  poolState: PoolState,
  snapshot: RateSnapshot,
  knobs: DecisionKnobs,
): DecisionRecord {
  // Use `??` not `||` so a legitimately-zero apr24h (new pool, no recent volume)
  // isn't silently swapped for the lifetime apr.
  const hodlmmApr = snapshot.hodlmm_apr24h_pct ?? snapshot.hodlmm_apr_pct;
  const zestApy = snapshot.zest_supply_apy_pct;
  const gap = hodlmmApr - zestApy; // positive = HODLMM winning

  const now = new Date();
  const hoursSinceSwitch = poolState.last_switched_at
    ? (now.getTime() - new Date(poolState.last_switched_at).getTime()) / 3_600_000
    : null;
  const dwellOk =
    hoursSinceSwitch === null || hoursSinceSwitch >= knobs.min_dwell_hours;

  // Amortize round-trip cost over expected dwell.
  // Example: 0.5% round-trip cost / (7 / 365) = 26.1% annualized drag,
  // directly comparable against the APR gap between protocols.
  const amortizedCostPct =
    knobs.round_trip_cost_pct / (knobs.expected_dwell_days / 365);
  const threshold =
    poolState.current_mode === "zest"
      ? knobs.enter_hodlmm_gap_pct + amortizedCostPct // HODLMM must beat Zest + cost
      : knobs.enter_zest_gap_pct + amortizedCostPct; // Zest must beat HODLMM + cost

  let decision: Decision = "stay";
  let reason = "";

  if (!dwellOk) {
    reason = `dwell not satisfied: ${hoursSinceSwitch?.toFixed(1)}h since last switch (min ${knobs.min_dwell_hours}h)`;
  } else if (poolState.current_mode === "hodlmm" || poolState.current_mode === "unknown") {
    // Considering switch to Zest: Zest must beat HODLMM by threshold
    if (-gap >= threshold) {
      decision = "switch_to_zest";
      reason = `Zest APY (${zestApy}%) beats HODLMM (${hodlmmApr}%) by ${(-gap).toFixed(2)}% ≥ threshold ${threshold.toFixed(2)}%`;
    } else {
      reason =
        poolState.current_mode === "unknown"
          ? `initial allocation stays neutral: HODLMM ${hodlmmApr}% vs Zest ${zestApy}%, gap ${gap.toFixed(2)}%`
          : `HODLMM holds: gap ${gap.toFixed(2)}% does not cross switch threshold ${(-threshold).toFixed(2)}%`;
    }
  } else if (poolState.current_mode === "zest") {
    if (gap >= threshold) {
      decision = "switch_to_hodlmm";
      reason = `HODLMM APR (${hodlmmApr}%) beats Zest (${zestApy}%) by ${gap.toFixed(2)}% ≥ threshold ${threshold.toFixed(2)}%`;
    } else {
      reason = `Zest holds: gap ${gap.toFixed(2)}% does not cross switch threshold ${threshold.toFixed(2)}%`;
    }
  }

  const netBenefit = Math.abs(gap) - amortizedCostPct;

  return {
    ts: now.toISOString(),
    decision,
    current_mode: poolState.current_mode,
    hodlmm_apr_pct: hodlmmApr,
    zest_apy_pct: zestApy,
    gap_pct: Number(gap.toFixed(4)),
    threshold_pct: Number(threshold.toFixed(4)),
    dwell_ok: dwellOk,
    hours_since_last_switch:
      hoursSinceSwitch !== null ? Number(hoursSinceSwitch.toFixed(2)) : null,
    cost_model: {
      round_trip_cost_pct: knobs.round_trip_cost_pct,
      expected_dwell_days: knobs.expected_dwell_days,
      net_benefit_pct: Number(netBenefit.toFixed(4)),
    },
    reason,
  };
}

// ─── Plan builder ───────────────────────────────────────────────────────
function buildPlan(
  poolId: string,
  decision: DecisionRecord,
  stxAddress: string,
): PlanStep[] {
  if (decision.decision === "stay") {
    return [];
  }
  if (decision.decision === "switch_to_zest") {
    return [
      {
        order: 1,
        action: "hodlmm-exit",
        description:
          "Fully withdraw from the HODLMM LP position. No skill in the registry currently exposes a full-exit primitive — hodlmm-move-liquidity only re-centers existing bins. Exit manually via the Bitflow web UI or a direct `dlmm-core-v-1-1::withdraw-relative-liquidity-same-multi` contract call with 100% shares. Do not proceed to step 2 until all LP shares are unstaked and STX + sBTC are back in the wallet.",
        invocation: {
          type: "user-confirm",
          prompt:
            "Confirm HODLMM LP position for pool " +
            poolId +
            " is fully withdrawn (no DLP shares remaining, STX + sBTC balances returned to wallet). Orchestrator must not execute subsequent steps until this is true.",
        },
      },
      {
        order: 2,
        action: "swap-stx-to-sbtc",
        description:
          "Swap the STX received from the HODLMM withdrawal into sBTC via the bitflow skill so the Zest supply is in a single asset. Orchestrator must substitute `<stx-balance-decimal>` with the post-exit STX balance in human-readable decimal (e.g. `21.0` for 21 STX); bitflow `--amount-in` is decimal-encoded, not sats.",
        invocation: {
          type: "cli",
          skill: "bitflow",
          command: "swap",
          args: [
            "--token-x",
            STX_TOKEN,
            "--token-y",
            SBTC_TOKEN,
            "--amount-in",
            "<stx-balance-decimal>",
            "--slippage-tolerance",
            "0.03",
            "--confirm-high-impact",
          ],
        },
      },
      {
        order: 3,
        action: "zest-supply",
        description:
          "Supply the resulting sBTC balance to Zest. Orchestrator must substitute `<sbtc-balance-sats>` with the post-swap sBTC balance in integer sats (Zest CLI takes raw sats, not decimal).",
        invocation: {
          type: "cli",
          skill: "zest-yield-manager",
          command: "run",
          args: ["--action=supply", "--amount=<sbtc-balance-sats>"],
        },
      },
    ];
  }
  // switch_to_hodlmm
  return [
    {
      order: 1,
      action: "zest-withdraw",
      description:
        "Withdraw the full sBTC supply from Zest back to the wallet. Orchestrator must substitute `<supplied-sbtc-sats>` with the concrete supplied balance (Zest has no `max` sentinel); read via `zest-yield-manager run --action=status` first.",
      invocation: {
        type: "cli",
        skill: "zest-yield-manager",
        command: "run",
        args: ["--action=withdraw", "--amount=<supplied-sbtc-sats>"],
      },
    },
    {
      order: 2,
      action: "swap-half-sbtc-to-stx",
      description:
        "Swap ~50% of the withdrawn sBTC to STX so the HODLMM deposit is placed at the pool's target ratio. Orchestrator must substitute `<50pct-sbtc-decimal>` with half the sBTC balance expressed in decimal (e.g. `0.00025` for 25k sats, not the raw integer).",
      invocation: {
        type: "cli",
        skill: "bitflow",
        command: "swap",
        args: [
          "--token-x",
          SBTC_TOKEN,
          "--token-y",
          STX_TOKEN,
          "--amount-in",
          "<50pct-sbtc-decimal>",
          "--slippage-tolerance",
          "0.03",
          "--confirm-high-impact",
        ],
      },
    },
    {
      order: 3,
      action: "hodlmm-deposit",
      description:
        "Deposit the rebalanced STX + sBTC into the HODLMM pool. No skill in the registry currently exposes a fresh-deposit primitive — hodlmm-move-liquidity only re-positions an existing LP position. Deposit manually via the Bitflow web UI or a direct `dlmm-liquidity-router-v-1-1::add-relative-liquidity-multi` contract call. Only mark the switch complete once DLP shares are confirmed at the target bin-radius.",
      invocation: {
        type: "user-confirm",
        prompt:
          "Confirm HODLMM LP position for pool " +
          poolId +
          " has been freshly deposited (STX + sBTC ~50/50 around the active bin, DLP shares visible on-chain for wallet " +
          stxAddress +
          "). Orchestrator must not call `set-mode --mode hodlmm` until this is true.",
      },
    },
  ];
}

// ─── Commands ───────────────────────────────────────────────────────────
async function cmdDoctor(poolId: string | undefined): Promise<void> {
  const issues: string[] = [];
  const checks: Record<string, unknown> = {};
  // HODLMM
  try {
    const apiList = await fetchJson<{ data?: unknown[]; pools?: unknown[] }>(
      `${HODLMM_APP_API}/pools`,
    );
    const count = (apiList.data || apiList.pools || []).length;
    checks.hodlmm_api = { reachable: true, pool_count: count };
    if (poolId) {
      try {
        const pool = await fetchHodlmmPool(poolId);
        checks.hodlmm_pool = {
          pool_id: pool.poolId,
          contract: pool.poolContract,
          status: pool.poolStatus,
          symbols: [pool.tokens.tokenX.symbol, pool.tokens.tokenY.symbol],
          apr: pool.apr,
          apr24h: pool.apr24h,
        };
        const sbtcIsX = pool.tokens.tokenX.contract === SBTC_TOKEN;
        const sbtcIsY = pool.tokens.tokenY.contract === SBTC_TOKEN;
        if (!sbtcIsX && !sbtcIsY) {
          issues.push(
            `pool ${poolId} is not sBTC-paired (router v1 only supports sBTC routing)`,
          );
        } else {
          // buildPlan hardcodes STX as the non-sBTC swap leg, so an sBTC/<non-STX>
          // pool would emit structurally wrong bitflow args. Gate that at doctor.
          const otherContract = sbtcIsX
            ? pool.tokens.tokenY.contract
            : pool.tokens.tokenX.contract;
          if (otherContract !== STX_TOKEN) {
            issues.push(
              `pool ${poolId} is sBTC-paired but non-STX counterpart (${otherContract}); router v1 plan builder assumes STX/sBTC`,
            );
          }
        }
      } catch (e) {
        issues.push(`HODLMM pool ${poolId} fetch failed: ${(e as Error).message}`);
      }
    }
  } catch (e) {
    checks.hodlmm_api = { reachable: false, error: (e as Error).message };
    issues.push("HODLMM app API unreachable");
  }
  // Zest
  try {
    const z = await fetchZestSupplyApy();
    checks.zest = {
      reachable: true,
      sbtc_supply_apy_pct: z.supply_apy_pct,
      sbtc_borrow_apy_pct: z.borrow_apy_pct,
      raw_rate: z.raw_rate,
      pool_reserve: ZEST_POOL_RESERVE,
    };
  } catch (e) {
    checks.zest = { reachable: false, error: (e as Error).message };
    issues.push("Zest readonly unreachable");
  }
  const state = loadState();
  checks.state = {
    path: STATE_PATH,
    tracked_pools: Object.keys(state.pools),
  };
  checks.composed_skills = {
    hodlmm_move_liquidity: "aibtcdev/skills/hodlmm-move-liquidity",
    zest_yield_manager: "aibtcdev/skills/zest-yield-manager",
    bitflow: "aibtcdev/skills/bitflow",
    note: "v1 emits a plan; execute by invoking the named skills per #483 composition rules",
  };
  const status: OutputStatus = issues.length > 0 ? "blocked" : "success";
  output({
    status,
    action: "doctor",
    data: { checks, issues },
    error:
      issues.length > 0
        ? { code: "DOCTOR_BLOCKED", message: issues.join("; ") }
        : null,
  });
}

async function cmdScan(poolId: string): Promise<boolean> {
  const state = loadState();
  const poolState = ensurePoolState(state, poolId);
  let hodlmmPool: HodlmmPoolDetail;
  try {
    hodlmmPool = await fetchHodlmmPool(poolId);
  } catch (e) {
    output({
      status: "error",
      action: "scan",
      data: null,
      error: { code: "HODLMM_FETCH_FAILED", message: (e as Error).message },
    });
    return false;
  }
  // A pool JSON with both apr fields missing is not a real "0% APR" signal —
  // treat it as stale data so decide() never biases toward switch_to_zest on
  // fabricated zeros.
  if (hodlmmPool.apr == null && hodlmmPool.apr24h == null) {
    output({
      status: "error",
      action: "scan",
      data: null,
      error: {
        code: "HODLMM_DATA_STALE",
        message: `pool ${poolId} returned no apr or apr24h fields`,
        next: "retry on next cycle; if persistent, verify the pool id or Bitflow schema",
      },
    });
    return false;
  }
  let zest: Awaited<ReturnType<typeof fetchZestSupplyApy>>;
  try {
    zest = await fetchZestSupplyApy();
  } catch (e) {
    output({
      status: "error",
      action: "scan",
      data: null,
      error: { code: "ZEST_FETCH_FAILED", message: (e as Error).message },
    });
    return false;
  }
  const snapshot: RateSnapshot = {
    ts: new Date().toISOString(),
    hodlmm_apr_pct: hodlmmPool.apr ?? hodlmmPool.apr24h ?? 0,
    hodlmm_apr24h_pct: hodlmmPool.apr24h ?? hodlmmPool.apr ?? 0,
    zest_supply_apy_pct: zest.supply_apy_pct,
    zest_borrow_apy_pct: zest.borrow_apy_pct,
    zest_rate_raw: zest.raw_rate,
    hodlmm_pool_id: poolId,
    hodlmm_tvl_usd: hodlmmPool.tvlUsd ?? null,
    hodlmm_volume_usd_1d: hodlmmPool.volumeUsd1d ?? null,
  };
  poolState.last_scan = snapshot;
  saveState(state);
  output({
    status: "success",
    action: "scan",
    data: snapshot,
    error: null,
  });
  return true;
}

async function cmdDecide(poolId: string, knobs: DecisionKnobs): Promise<boolean> {
  const state = loadState();
  const poolState = ensurePoolState(state, poolId);
  if (!poolState.last_scan) {
    output({
      status: "blocked",
      action: "decide",
      data: null,
      error: {
        code: "NO_SCAN",
        message: `no prior scan for pool ${poolId}`,
        next: `run \`scan --pool ${poolId}\` first`,
      },
    });
    return false;
  }
  // Reuse last scan if fresh (<15 min); otherwise re-scan. If the re-scan
  // fails we refuse to decide rather than persisting a DecisionRecord computed
  // on stale input — history fidelity + orchestrator trust matter more than
  // returning an answer.
  const scanAgeMs = Date.now() - new Date(poolState.last_scan.ts).getTime();
  const needsRescan = scanAgeMs > 15 * 60 * 1000;
  if (needsRescan) {
    log(`last scan is ${Math.round(scanAgeMs / 60000)} min old — re-scanning`);
    try {
      const hodlmmPool = await fetchHodlmmPool(poolId);
      if (hodlmmPool.apr == null && hodlmmPool.apr24h == null) {
        throw new Error(`pool ${poolId} returned no apr or apr24h fields`);
      }
      const zest = await fetchZestSupplyApy();
      poolState.last_scan = {
        ts: new Date().toISOString(),
        hodlmm_apr_pct: hodlmmPool.apr ?? hodlmmPool.apr24h ?? 0,
        hodlmm_apr24h_pct: hodlmmPool.apr24h ?? hodlmmPool.apr ?? 0,
        zest_supply_apy_pct: zest.supply_apy_pct,
        zest_borrow_apy_pct: zest.borrow_apy_pct,
        zest_rate_raw: zest.raw_rate,
        hodlmm_pool_id: poolId,
        hodlmm_tvl_usd: hodlmmPool.tvlUsd ?? null,
        hodlmm_volume_usd_1d: hodlmmPool.volumeUsd1d ?? null,
      };
      saveState(state);
    } catch (e) {
      output({
        status: "error",
        action: "decide",
        data: null,
        error: {
          code: "RESCAN_FAILED",
          message: `last scan is ${Math.round(scanAgeMs / 60000)} min old and re-scan failed: ${(e as Error).message}`,
          next: "retry on next cycle; refusing to decide on stale data",
        },
      });
      return false;
    }
  }
  const decision = decide(poolState, poolState.last_scan, knobs);
  poolState.last_decision = decision;
  poolState.history.push(decision);
  if (poolState.history.length > MAX_HISTORY) {
    poolState.history = poolState.history.slice(-MAX_HISTORY);
  }
  saveState(state);
  output({
    status: "success",
    action: "decide",
    data: {
      decision,
      knobs,
      scan_age_min: Math.round(
        (Date.now() - new Date(poolState.last_scan.ts).getTime()) / 60000,
      ),
      scan_stale: false,
    },
    error: null,
  });
  return true;
}

async function cmdPlan(
  poolId: string,
  stxAddress: string,
  knobs: DecisionKnobs,
): Promise<void> {
  const state = loadState();
  const poolState = state.pools[poolId];
  if (!poolState?.last_decision) {
    output({
      status: "blocked",
      action: "plan",
      data: null,
      error: {
        code: "NO_DECISION",
        message: `no decision for ${poolId}`,
        next: `run \`decide --pool ${poolId}\` first`,
      },
    });
    return;
  }
  const steps = buildPlan(poolId, poolState.last_decision, stxAddress);
  output({
    status: "success",
    action: "plan",
    data: {
      pool_id: poolId,
      decision: poolState.last_decision.decision,
      reason: poolState.last_decision.reason,
      steps,
      step_count: steps.length,
      notes:
        steps.length === 0
          ? "decision was 'stay' — no actions required this cycle"
          : "execute steps in order; router does not write on-chain in v1, compose via named skills",
      knobs,
    },
    error: null,
  });
}

async function cmdRun(
  poolId: string,
  stxAddress: string,
  knobs: DecisionKnobs,
  confirm: boolean,
): Promise<void> {
  // run = scan + decide + plan in one cycle. Short-circuit on stage failure so
  // orchestrators reading `tail -n 1 | jq .data` don't mistake a failed cycle's
  // trailing NO_SCAN/NO_DECISION plan envelope for a legitimate `stay`.
  const scanOk = await cmdScan(poolId);
  if (!scanOk) return;
  const decideOk = await cmdDecide(poolId, knobs);
  if (!decideOk) return;
  await cmdPlan(poolId, stxAddress, knobs);
  if (confirm) {
    log(
      "--confirm is a no-op in v1: execution is delegated to downstream skills per #483. Invoke the plan steps in order from your orchestrator.",
    );
  }
}

function cmdStatus(poolId: string): void {
  const state = loadState();
  const poolState = state.pools[poolId];
  if (!poolState) {
    output({
      status: "success",
      action: "status",
      data: { pool_id: poolId, current_mode: "unknown", tracked: false },
      error: null,
    });
    return;
  }
  output({
    status: "success",
    action: "status",
    data: {
      pool_id: poolId,
      current_mode: poolState.current_mode,
      last_switched_at: poolState.last_switched_at,
      last_scan: poolState.last_scan,
      last_decision: poolState.last_decision,
      history_count: poolState.history.length,
    },
    error: null,
  });
}

function cmdHistory(poolId: string, limit: number): void {
  const state = loadState();
  const poolState = state.pools[poolId];
  const slice = (poolState?.history ?? []).slice(-limit);
  output({
    status: "success",
    action: "history",
    data: {
      pool_id: poolId,
      history: slice,
      total: poolState?.history.length ?? 0,
      returned: slice.length,
    },
    error: null,
  });
}

function cmdSetMode(poolId: string, mode: Mode): void {
  const state = loadState();
  const poolState = ensurePoolState(state, poolId);
  // Always reset last_switched_at — SKILL.md documents this as the sanctioned
  // way to restart the dwell clock, including when re-confirming the same mode
  // after a manual re-deposit. A conditional update would silently no-op that.
  poolState.last_switched_at = new Date().toISOString();
  poolState.current_mode = mode;
  saveState(state);
  output({
    status: "success",
    action: "set-mode",
    data: { pool_id: poolId, current_mode: mode, last_switched_at: poolState.last_switched_at },
    error: null,
  });
}

function cmdInstallPacks(): void {
  output({
    status: "success",
    action: "install-packs",
    data: {
      packs: [],
      requires_downstream_skills: [
        "hodlmm-move-liquidity (aibtcdev/skills)",
        "zest-yield-manager (aibtcdev/skills)",
        "bitflow (aibtcdev/skills)",
      ],
      note: "Router emits plan steps that invoke these skills via CLI per #483 composition rules.",
    },
    error: null,
  });
}

// ─── CLI wiring ─────────────────────────────────────────────────────────
function parseKnobs(opts: {
  enterZestGap: string;
  enterHodlmmGap: string;
  minDwell: string;
  cost: string;
  dwellDays: string;
}): DecisionKnobs {
  return {
    enter_zest_gap_pct: parseFloat(opts.enterZestGap),
    enter_hodlmm_gap_pct: parseFloat(opts.enterHodlmmGap),
    min_dwell_hours: parseFloat(opts.minDwell),
    round_trip_cost_pct: parseFloat(opts.cost),
    expected_dwell_days: parseFloat(opts.dwellDays),
  };
}

function validateKnobs(k: DecisionKnobs): string | null {
  for (const [name, val] of Object.entries(k)) {
    if (!Number.isFinite(val) || val < 0) return `${name} must be a non-negative number`;
  }
  if (k.expected_dwell_days <= 0) return "expected_dwell_days must be positive";
  if (k.min_dwell_hours < 1) return "min_dwell_hours must be at least 1";
  return null;
}

async function main(): Promise<void> {
  const program = new Command();
  program
    .name("hodlmm-zest-yield-router")
    .description("Route sBTC between HODLMM LP and Zest supply by live APY");

  const knobOpts = [
    ["--enter-zest-gap <pct>", "Zest APY - HODLMM APR gap to switch to Zest", String(DEFAULT_ENTER_ZEST_GAP_PCT)] as const,
    ["--enter-hodlmm-gap <pct>", "HODLMM APR - Zest APY gap to switch to HODLMM", String(DEFAULT_ENTER_HODLMM_GAP_PCT)] as const,
    ["--min-dwell <hours>", "min hours between switches", String(DEFAULT_MIN_DWELL_HOURS)] as const,
    ["--cost <pct>", "round-trip cost pct of capital (gas + slippage)", String(DEFAULT_ROUND_TRIP_COST_PCT)] as const,
    ["--dwell-days <n>", "expected dwell in days for cost amortization", String(DEFAULT_EXPECTED_DWELL_DAYS)] as const,
  ];

  program
    .command("doctor")
    .option("--pool <id>", "target HODLMM pool id")
    .action(async (opts: { pool?: string }) => {
      await cmdDoctor(opts.pool);
    });

  program
    .command("scan")
    .requiredOption("--pool <id>", "HODLMM pool id")
    .action(async (opts: { pool: string }) => {
      await cmdScan(opts.pool);
    });

  const decideCmd = program
    .command("decide")
    .requiredOption("--pool <id>", "HODLMM pool id");
  for (const [flag, desc, def] of knobOpts) decideCmd.option(flag, desc, def);
  decideCmd.action(async (opts) => {
    const knobs = parseKnobs({
      enterZestGap: opts.enterZestGap,
      enterHodlmmGap: opts.enterHodlmmGap,
      minDwell: opts.minDwell,
      cost: opts.cost,
      dwellDays: opts.dwellDays,
    });
    const err = validateKnobs(knobs);
    if (err) {
      output({
        status: "error",
        action: "decide",
        data: null,
        error: { code: "BAD_KNOB", message: err },
      });
      return;
    }
    await cmdDecide(opts.pool, knobs);
  });

  const planCmd = program
    .command("plan")
    .requiredOption("--pool <id>", "HODLMM pool id")
    .requiredOption("--stx-address <addr>", "STX address for downstream invocations");
  for (const [flag, desc, def] of knobOpts) planCmd.option(flag, desc, def);
  planCmd.action(async (opts) => {
    const knobs = parseKnobs({
      enterZestGap: opts.enterZestGap,
      enterHodlmmGap: opts.enterHodlmmGap,
      minDwell: opts.minDwell,
      cost: opts.cost,
      dwellDays: opts.dwellDays,
    });
    await cmdPlan(opts.pool, opts.stxAddress, knobs);
  });

  const runCmd = program
    .command("run")
    .requiredOption("--pool <id>", "HODLMM pool id")
    .requiredOption("--stx-address <addr>", "STX address for downstream invocations")
    .option("--confirm", "acknowledge router-v1 is decision+plan only (no-op)", false);
  for (const [flag, desc, def] of knobOpts) runCmd.option(flag, desc, def);
  runCmd.action(async (opts) => {
    const knobs = parseKnobs({
      enterZestGap: opts.enterZestGap,
      enterHodlmmGap: opts.enterHodlmmGap,
      minDwell: opts.minDwell,
      cost: opts.cost,
      dwellDays: opts.dwellDays,
    });
    const err = validateKnobs(knobs);
    if (err) {
      output({
        status: "error",
        action: "run",
        data: null,
        error: { code: "BAD_KNOB", message: err },
      });
      return;
    }
    await cmdRun(opts.pool, opts.stxAddress, knobs, Boolean(opts.confirm));
  });

  program
    .command("status")
    .requiredOption("--pool <id>", "HODLMM pool id")
    .action((opts: { pool: string }) => {
      cmdStatus(opts.pool);
    });

  program
    .command("history")
    .requiredOption("--pool <id>", "HODLMM pool id")
    .option("--limit <n>", "most recent N decisions", "50")
    .action((opts: { pool: string; limit: string }) => {
      cmdHistory(opts.pool, parseInt(opts.limit, 10));
    });

  program
    .command("set-mode")
    .description(
      "Manually set current_mode (hodlmm|zest|unknown). Useful for bootstrapping state after a manual move.",
    )
    .requiredOption("--pool <id>", "HODLMM pool id")
    .requiredOption("--mode <mode>", "hodlmm | zest | unknown")
    .action((opts: { pool: string; mode: string }) => {
      const mode = opts.mode as Mode;
      if (mode !== "hodlmm" && mode !== "zest" && mode !== "unknown") {
        output({
          status: "error",
          action: "set-mode",
          data: null,
          error: { code: "BAD_MODE", message: "--mode must be hodlmm|zest|unknown" },
        });
        return;
      }
      cmdSetMode(opts.pool, mode);
    });

  program
    .command("install-packs")
    .option("--pack <name>", "ignored", "all")
    .action(() => cmdInstallPacks());

  await program.parseAsync(process.argv);
}

main().catch((e: unknown) => {
  const err = e as Error;
  output({
    status: "error",
    action: "unknown",
    data: null,
    error: { code: "FATAL", message: err.message ?? String(e) },
  });
  process.exit(1);
});
