#!/usr/bin/env bun
/**
 * hodlmm-liquidity-tide — Liquidity Flow Momentum Signal for HODLMM
 *
 * Tracks net liquidity flow across HODLMM pools by snapshotting bin reserves
 * over time. Compares rolling windows to detect accumulation (RISING) vs
 * distribution (FALLING) phases. Outputs a composable timing signal.
 *
 * Commands:
 *   doctor   — check API access, pool count, snapshot state
 *   snapshot — capture current liquidity state across all pools
 *   run      — analyze tide direction, momentum, and signal
 *   history  — show snapshot history and tide transitions
 */

import { Command } from "commander";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// ─── Config ───────────────────────────────────────────────────────────────
const HODLMM_QUOTES_API = "https://bff.bitflowapis.finance/api/quotes/v1";
const HODLMM_APP_API = "https://bff.bitflowapis.finance/api/app/v1";

const STATE_PATH = join(homedir(), ".hodlmm-liquidity-tide.json");
const MAX_SNAPSHOTS = 2016; // 7 days at 5-min intervals
const MIN_SNAPSHOTS_FOR_SIGNAL = 2;

// Rolling windows in minutes
const WINDOWS = {
  "1h": 60,
  "4h": 240,
  "24h": 1440,
};

// Tide thresholds (% change in reserves)
const RISING_THRESHOLD = 0.5; // +0.5% = accumulation
const FALLING_THRESHOLD = -0.5; // -0.5% = distribution
const HIGH_MOMENTUM = 1.5; // momentum multiplier for high confidence

// ─── Output ──────────────────────────────────────────────────────────────
function output(status: string, action: string, data: any, error: any = null) {
  console.log(JSON.stringify({ status, action, data, error }));
}

function log(...args: any[]) {
  console.error("[liquidity-tide]", ...args);
}

// ─── Types ───────────────────────────────────────────────────────────────
interface PoolSnapshot {
  poolId: string;
  totalReserveX: number; // raw token units (price-independent)
  totalReserveY: number;
  totalLiquidity: number; // sum of bin liquidity values
  activeBin: number;
  activeBinCount: number; // bins with non-zero liquidity
  tvlUsd: number;
  volumeUsd1d: number;
  feesUsd1d: number;
}

interface Snapshot {
  timestamp: string;
  epochMs: number;
  pools: PoolSnapshot[];
}

interface State {
  snapshots: Snapshot[];
}

// ─── State ───────────────────────────────────────────────────────────────
function loadState(): State {
  try {
    if (existsSync(STATE_PATH)) {
      return JSON.parse(readFileSync(STATE_PATH, "utf-8"));
    }
  } catch {}
  return { snapshots: [] };
}

function saveState(state: State): void {
  // Prune old snapshots
  if (state.snapshots.length > MAX_SNAPSHOTS) {
    state.snapshots = state.snapshots.slice(-MAX_SNAPSHOTS);
  }
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

// ─── API ─────────────────────────────────────────────────────────────────
async function fetchJson(url: string): Promise<any> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!r.ok) return null;
    return r.json();
  } catch {
    return null;
  }
}

interface PoolMeta {
  pool_id: string;
  active_bin: number;
  bin_step: number;
  token_x: string;
  token_y: string;
}

async function fetchPools(): Promise<PoolMeta[]> {
  const data = await fetchJson(`${HODLMM_QUOTES_API}/pools`);
  return data?.pools || [];
}

interface BinRaw {
  bin_id: number;
  reserve_x: string;
  reserve_y: string;
  liquidity: string;
}

async function fetchPoolBins(poolId: string): Promise<{ activeBin: number; bins: BinRaw[] } | null> {
  const data = await fetchJson(`${HODLMM_QUOTES_API}/bins/${poolId}`);
  if (!data?.bins) return null;
  return { activeBin: data.active_bin_id ?? 0, bins: data.bins };
}

interface AppPoolStats {
  poolId: string;
  tvlUsd: number;
  volumeUsd1d: number;
  feesUsd1d: number;
}

async function fetchAppStats(): Promise<AppPoolStats[]> {
  const data = await fetchJson(`${HODLMM_APP_API}/pools`);
  if (!data) return [];
  const pools = Array.isArray(data) ? data : data.data || data.pools || [];
  return pools.map((p: any) => ({
    poolId: p.poolId || p.pool_id,
    tvlUsd: p.tvlUsd || 0,
    volumeUsd1d: p.volumeUsd1d || 0,
    feesUsd1d: p.feesUsd1d || 0,
  }));
}

// ─── Snapshot Builder ────────────────────────────────────────────────────
async function buildSnapshot(): Promise<Snapshot | null> {
  const [pools, appStats] = await Promise.all([fetchPools(), fetchAppStats()]);
  if (!pools.length) return null;

  const statsMap = new Map(appStats.map((s) => [s.poolId, s]));

  const poolSnapshots: PoolSnapshot[] = [];

  // Fetch all pool bins in parallel
  const binResults = await Promise.allSettled(
    pools.map(async (pool) => {
      const binData = await fetchPoolBins(pool.pool_id);
      if (!binData) return null;
      return { poolId: pool.pool_id, ...binData };
    })
  );

  for (const result of binResults) {
    if (result.status !== "fulfilled" || !result.value) continue;
    const { poolId, activeBin, bins } = result.value;

    let totalReserveX = 0;
    let totalReserveY = 0;
    let totalLiquidity = 0;
    let activeBinCount = 0;

    for (const bin of bins) {
      const rx = parseInt(bin.reserve_x || "0");
      const ry = parseInt(bin.reserve_y || "0");
      const liq = parseInt(bin.liquidity || "0");
      totalReserveX += rx;
      totalReserveY += ry;
      totalLiquidity += liq;
      if (liq > 0) activeBinCount++;
    }

    const stats = statsMap.get(poolId);

    poolSnapshots.push({
      poolId,
      totalReserveX,
      totalReserveY,
      totalLiquidity,
      activeBin,
      activeBinCount,
      tvlUsd: stats?.tvlUsd || 0,
      volumeUsd1d: stats?.volumeUsd1d || 0,
      feesUsd1d: stats?.feesUsd1d || 0,
    });
  }

  if (poolSnapshots.length === 0) return null;

  return {
    timestamp: new Date().toISOString(),
    epochMs: Date.now(),
    pools: poolSnapshots,
  };
}

// ─── Tide Analysis ───────────────────────────────────────────────────────
interface TideSignal {
  poolId: string;
  tide: "RISING" | "FALLING" | "SLACK";
  momentum: number; // absolute magnitude of flow rate
  confidence: "high" | "medium" | "low";
  signal: "ENTER" | "EXIT" | "CAUTION" | "WAIT" | "HOLD";
  liquidityFlowPct1h: string | null; // LP shares (only changes on add/remove)
  liquidityFlowPct4h: string | null;
  liquidityFlowPct24h: string | null;
  reserveXFlowPct1h: string | null; // per-token context (includes swap noise)
  reserveYFlowPct1h: string | null;
  tvlFlowPct1h: string | null; // USD (includes price effects)
  currentTvlUsd: number;
  currentLiquidity: number; // LP share total
  activeBin: number;
  activeBinCount: number;
  snapshotsUsed: number;
}

function pctChange(current: number, previous: number): number {
  if (previous === 0) return 0;
  return ((current - previous) / previous) * 100;
}

function formatPct(val: number | null): string | null {
  if (val === null) return null;
  return (val >= 0 ? "+" : "") + val.toFixed(2) + "%";
}

function findSnapshotAtWindow(
  snapshots: Snapshot[],
  latestEpoch: number,
  windowMinutes: number
): Snapshot | null {
  const targetEpoch = latestEpoch - windowMinutes * 60_000;
  let closest: Snapshot | null = null;
  let closestDiff = Infinity;

  for (const snap of snapshots) {
    const diff = Math.abs(snap.epochMs - targetEpoch);
    // Allow 50% tolerance
    if (diff < closestDiff && diff < windowMinutes * 60_000 * 0.5) {
      closest = snap;
      closestDiff = diff;
    }
  }
  return closest;
}

function analyzeTide(
  poolId: string,
  snapshots: Snapshot[]
): TideSignal | null {
  if (snapshots.length < MIN_SNAPSHOTS_FOR_SIGNAL) return null;

  const latest = snapshots[snapshots.length - 1];
  const latestPool = latest.pools.find((p) => p.poolId === poolId);
  if (!latestPool) return null;

  // Calculate flow rates for each window using LP share totals (totalLiquidity).
  // LP shares only change when liquidity is added or removed — swaps shift
  // reserves between X and Y but leave the share supply unchanged. This
  // separates genuine LP flow from normal trading activity.
  const flowRates: Record<string, {
    liquidityPct: number; // primary: LP shares (swap-independent)
    reserveXPct: number; // context only
    reserveYPct: number; // context only
    tvlPct: number; // includes price effects
  } | null> = {};

  for (const [windowName, windowMinutes] of Object.entries(WINDOWS)) {
    const oldSnap = findSnapshotAtWindow(snapshots, latest.epochMs, windowMinutes);
    if (!oldSnap) {
      flowRates[windowName] = null;
      continue;
    }

    const oldPool = oldSnap.pools.find((p) => p.poolId === poolId);
    if (!oldPool) {
      flowRates[windowName] = null;
      continue;
    }

    // Primary metric: LP share change (price- and swap-independent)
    const liquidityPct = pctChange(latestPool.totalLiquidity, oldPool.totalLiquidity);

    // Per-token reserve context (includes swap noise, tracked separately)
    const reserveXPct = pctChange(latestPool.totalReserveX, oldPool.totalReserveX);
    const reserveYPct = pctChange(latestPool.totalReserveY, oldPool.totalReserveY);

    // TVL-based flow (includes price effects)
    const tvlPct = pctChange(latestPool.tvlUsd, oldPool.tvlUsd);

    flowRates[windowName] = { liquidityPct, reserveXPct, reserveYPct, tvlPct };
  }

  // Determine tide using the shortest available window for responsiveness
  // Fall back to longer windows if shorter ones aren't available
  let primaryFlow: number | null = null;
  let primaryWindow = "";

  for (const windowName of ["1h", "4h", "24h"]) {
    if (flowRates[windowName]) {
      primaryFlow = flowRates[windowName]!.liquidityPct;
      primaryWindow = windowName;
      break;
    }
  }

  if (primaryFlow === null) {
    // Use raw first-to-last comparison on LP shares
    const firstSnap = snapshots[0];
    const firstPool = firstSnap.pools.find((p) => p.poolId === poolId);
    if (!firstPool) return null;

    primaryFlow = pctChange(latestPool.totalLiquidity, firstPool.totalLiquidity);
    primaryWindow = "raw";
  }

  // Classify tide
  let tide: "RISING" | "FALLING" | "SLACK";
  if (primaryFlow > RISING_THRESHOLD) {
    tide = "RISING";
  } else if (primaryFlow < FALLING_THRESHOLD) {
    tide = "FALLING";
  } else {
    tide = "SLACK";
  }

  // Calculate momentum (absolute flow rate, normalized)
  const momentum = Math.abs(primaryFlow) / Math.max(RISING_THRESHOLD, 0.01);

  // Confidence based on data depth and momentum
  let confidence: "high" | "medium" | "low";
  const hasMultipleWindows = Object.values(flowRates).filter((v) => v !== null).length;

  if (momentum >= HIGH_MOMENTUM && hasMultipleWindows >= 2) {
    confidence = "high";
  } else if (momentum >= 1.0 || hasMultipleWindows >= 2) {
    confidence = "medium";
  } else {
    confidence = "low";
  }

  // Signal
  let signal: "ENTER" | "EXIT" | "CAUTION" | "WAIT" | "HOLD";
  if (tide === "RISING" && confidence === "high") {
    signal = "ENTER";
  } else if (tide === "RISING") {
    signal = "WAIT";
  } else if (tide === "FALLING" && confidence === "high") {
    signal = "EXIT";
  } else if (tide === "FALLING") {
    signal = "CAUTION";
  } else {
    signal = "HOLD";
  }

  return {
    poolId,
    tide,
    momentum: Math.round(momentum * 100) / 100,
    confidence,
    signal,
    liquidityFlowPct1h: formatPct(flowRates["1h"]?.liquidityPct ?? null),
    liquidityFlowPct4h: formatPct(flowRates["4h"]?.liquidityPct ?? null),
    liquidityFlowPct24h: formatPct(flowRates["24h"]?.liquidityPct ?? null),
    reserveXFlowPct1h: formatPct(flowRates["1h"]?.reserveXPct ?? null),
    reserveYFlowPct1h: formatPct(flowRates["1h"]?.reserveYPct ?? null),
    tvlFlowPct1h: formatPct(flowRates["1h"]?.tvlPct ?? null),
    currentTvlUsd: latestPool.tvlUsd,
    currentLiquidity: latestPool.totalLiquidity,
    activeBin: latestPool.activeBin,
    activeBinCount: latestPool.activeBinCount,
    snapshotsUsed: snapshots.length,
  };
}

// ─── CLI ─────────────────────────────────────────────────────────────────
const program = new Command();

program
  .name("hodlmm-liquidity-tide")
  .description("Track net liquidity flow across HODLMM pools — timing signal for LP entry/exit");

// doctor
program
  .command("doctor")
  .description("Check API access, pool availability, and snapshot state")
  .action(async () => {
    const checks: any = {
      hodlmmApi: false,
      appApi: false,
      pools: [],
      snapshotState: {
        fileExists: existsSync(STATE_PATH),
        totalSnapshots: 0,
        oldestSnapshot: null,
        newestSnapshot: null,
        poolsCovered: 0,
      },
      commands: ["doctor", "snapshot", "run", "run --pool dlmm_1", "history"],
    };

    // Check quotes API
    const pools = await fetchPools();
    if (pools.length > 0) {
      checks.hodlmmApi = true;
      checks.pools = pools.map((p) => ({
        poolId: p.pool_id,
        activeBin: p.active_bin,
        binStep: p.bin_step,
      }));
    }

    // Check app API
    const appStats = await fetchAppStats();
    if (appStats.length > 0) {
      checks.appApi = true;
    }

    // Snapshot state
    const state = loadState();
    if (state.snapshots.length > 0) {
      const oldest = state.snapshots[0];
      const newest = state.snapshots[state.snapshots.length - 1];
      const poolIds = new Set<string>();
      for (const snap of state.snapshots) {
        for (const p of snap.pools) poolIds.add(p.poolId);
      }

      checks.snapshotState.totalSnapshots = state.snapshots.length;
      checks.snapshotState.oldestSnapshot = oldest.timestamp;
      checks.snapshotState.newestSnapshot = newest.timestamp;
      checks.snapshotState.poolsCovered = poolIds.size;

      const spanMinutes = (newest.epochMs - oldest.epochMs) / 60_000;
      checks.snapshotState.timeSpanMinutes = Math.round(spanMinutes);
      checks.snapshotState.avgIntervalMinutes =
        state.snapshots.length > 1
          ? Math.round(spanMinutes / (state.snapshots.length - 1))
          : null;
    }

    checks.readyForAnalysis = state.snapshots.length >= MIN_SNAPSHOTS_FOR_SIGNAL;
    checks.note = state.snapshots.length < MIN_SNAPSHOTS_FOR_SIGNAL
      ? `Need ${MIN_SNAPSHOTS_FOR_SIGNAL - state.snapshots.length} more snapshot(s) before tide analysis. Run \`snapshot\` periodically.`
      : `${state.snapshots.length} snapshots available. Ready for tide analysis.`;

    output("success", "doctor", checks);
  });

// snapshot
program
  .command("snapshot")
  .description("Capture current liquidity state across all HODLMM pools")
  .action(async () => {
    log("Taking liquidity snapshot...");

    const snapshot = await buildSnapshot();
    if (!snapshot) {
      output("error", "snapshot", null, "Failed to fetch pool data from HODLMM API.");
      return;
    }

    const state = loadState();
    state.snapshots.push(snapshot);
    saveState(state);

    const poolSummary = snapshot.pools.map((p) => ({
      poolId: p.poolId,
      totalReserveX: p.totalReserveX,
      totalReserveY: p.totalReserveY,
      activeBinCount: p.activeBinCount,
      tvlUsd: p.tvlUsd,
    }));

    // Quick delta from previous snapshot if available
    let deltas: any[] | null = null;
    if (state.snapshots.length >= 2) {
      const prev = state.snapshots[state.snapshots.length - 2];
      deltas = snapshot.pools.map((current) => {
        const old = prev.pools.find((p) => p.poolId === current.poolId);
        if (!old) return { poolId: current.poolId, delta: "new pool" };
        // Use LP share change as primary flow indicator (swap-independent)
        const liqChangePct = pctChange(current.totalLiquidity, old.totalLiquidity);
        return {
          poolId: current.poolId,
          liquidityChangePct: formatPct(liqChangePct),
          tvlChangePct: formatPct(pctChange(current.tvlUsd, old.tvlUsd)),
          direction: liqChangePct > 0.1 ? "INFLOW" : liqChangePct < -0.1 ? "OUTFLOW" : "STABLE",
        };
      });
    }

    output("success", "snapshot", {
      timestamp: snapshot.timestamp,
      poolsCaptures: snapshot.pools.length,
      totalSnapshotsStored: state.snapshots.length,
      pools: poolSummary,
      deltaSincePrevious: deltas,
    });
  });

// run
program
  .command("run")
  .description("Analyze liquidity tide across pools")
  .option("--pool <id>", "Analyze a specific pool only")
  .action(async (opts) => {
    const state = loadState();

    if (state.snapshots.length < MIN_SNAPSHOTS_FOR_SIGNAL) {
      output("blocked", "run", {
        currentSnapshots: state.snapshots.length,
        required: MIN_SNAPSHOTS_FOR_SIGNAL,
        hint: `Need ${MIN_SNAPSHOTS_FOR_SIGNAL - state.snapshots.length} more snapshot(s). Run \`snapshot\` first.`,
      }, "Insufficient snapshot data for tide analysis.");
      return;
    }

    // Collect all pool IDs from latest snapshot
    const latest = state.snapshots[state.snapshots.length - 1];
    let poolIds = latest.pools.map((p) => p.poolId);

    if (opts.pool) {
      if (!poolIds.includes(opts.pool)) {
        output("error", "run", null, `Pool ${opts.pool} not found in latest snapshot. Available: ${poolIds.join(", ")}`);
        return;
      }
      poolIds = [opts.pool];
    }

    const signals: TideSignal[] = [];

    for (const poolId of poolIds) {
      const signal = analyzeTide(poolId, state.snapshots);
      if (signal) signals.push(signal);
    }

    if (signals.length === 0) {
      output("success", "run", {
        pools: [],
        note: "No pools had enough data for tide analysis.",
      });
      return;
    }

    // Overall market tide (aggregate)
    const risingCount = signals.filter((s) => s.tide === "RISING").length;
    const fallingCount = signals.filter((s) => s.tide === "FALLING").length;
    const slackCount = signals.filter((s) => s.tide === "SLACK").length;
    const avgMomentum = signals.reduce((s, sig) => s + sig.momentum, 0) / signals.length;

    let marketTide: "RISING" | "FALLING" | "MIXED" | "SLACK";
    if (risingCount > fallingCount && risingCount > slackCount) {
      marketTide = "RISING";
    } else if (fallingCount > risingCount && fallingCount > slackCount) {
      marketTide = "FALLING";
    } else if (risingCount > 0 && fallingCount > 0) {
      marketTide = "MIXED";
    } else {
      marketTide = "SLACK";
    }

    const oldest = state.snapshots[0];
    const timeSpanMinutes = Math.round((latest.epochMs - oldest.epochMs) / 60_000);

    output("success", "run", {
      analysisTimestamp: new Date().toISOString(),
      snapshotDepth: state.snapshots.length,
      timeSpanMinutes,
      marketTide,
      avgMomentum: Math.round(avgMomentum * 100) / 100,
      summary: {
        rising: risingCount,
        falling: fallingCount,
        slack: slackCount,
      },
      pools: signals,
    });
  });

// history
program
  .command("history")
  .description("Show snapshot history and tide transitions")
  .option("--pool <id>", "Filter history to a specific pool")
  .option("--limit <n>", "Number of recent snapshots to show", "20")
  .action(async (opts) => {
    const state = loadState();

    if (state.snapshots.length === 0) {
      output("success", "history", {
        snapshots: [],
        note: "No snapshots recorded yet. Run `snapshot` to start tracking.",
      });
      return;
    }

    const limit = parseInt(opts.limit) || 20;
    const recentSnapshots = state.snapshots.slice(-limit);

    const timelineEntries: any[] = [];

    for (let i = 0; i < recentSnapshots.length; i++) {
      const snap = recentSnapshots[i];
      const entry: any = {
        timestamp: snap.timestamp,
        pools: [],
      };

      for (const pool of snap.pools) {
        if (opts.pool && pool.poolId !== opts.pool) continue;

        const poolEntry: any = {
          poolId: pool.poolId,
          totalReserveX: pool.totalReserveX,
          totalReserveY: pool.totalReserveY,
          tvlUsd: pool.tvlUsd,
          activeBinCount: pool.activeBinCount,
        };

        // Delta from previous snapshot (LP shares = swap-independent)
        if (i > 0) {
          const prevSnap = recentSnapshots[i - 1];
          const prevPool = prevSnap.pools.find((p) => p.poolId === pool.poolId);
          if (prevPool) {
            poolEntry.liquidityChangePct = formatPct(pctChange(pool.totalLiquidity, prevPool.totalLiquidity));
            poolEntry.tvlChangePct = formatPct(pctChange(pool.tvlUsd, prevPool.tvlUsd));
          }
        }

        entry.pools.push(poolEntry);
      }

      if (entry.pools.length > 0) {
        timelineEntries.push(entry);
      }
    }

    const oldest = state.snapshots[0];
    const newest = state.snapshots[state.snapshots.length - 1];

    output("success", "history", {
      totalSnapshots: state.snapshots.length,
      oldestSnapshot: oldest.timestamp,
      newestSnapshot: newest.timestamp,
      timeSpanMinutes: Math.round((newest.epochMs - oldest.epochMs) / 60_000),
      showing: timelineEntries.length,
      timeline: timelineEntries,
    });
  });

// ─── CLI bootstrap ───────────────────────────────────────────────────────
program.exitOverride();
program.configureOutput({
  writeOut: (str) => console.error(str),
  writeErr: (str) => console.error(str),
  outputError: (str) => console.error(str),
});

try {
  await program.parseAsync();
} catch (e: any) {
  if (e.code === "commander.helpDisplayed" || e.code === "commander.version") process.exit(0);
  const msg = e.message?.replace(/^error: /, "") || String(e);
  output("error", "cli", null, msg);
  process.exit(1);
}
