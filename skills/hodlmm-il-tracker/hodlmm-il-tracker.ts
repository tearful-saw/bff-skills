#!/usr/bin/env bun
/**
 * hodlmm-il-tracker — Impermanent Loss tracker for HODLMM positions
 *
 * Tracks real-time impermanent loss on live concentrated-liquidity positions
 * by comparing current LP value to a HODL-only baseline recorded at entry.
 *
 * Commands:
 *   doctor   — check wallet, API access, positions
 *   snapshot — record current position as entry baseline (or re-snapshot)
 *   status   — show IL for all tracked positions
 *   run      — full cycle: snapshot new, report IL on existing, record history
 *   history  — show IL trend over time
 */

import { Command } from "commander";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// ─── Config ───────────────────────────────────────────────────────────────
const HODLMM_API = "https://bff.bitflowapis.finance/api/quotes/v1";
const HODLMM_APP_API = "https://bff.bitflowapis.finance";
const HIRO_API = "https://api.hiro.so";

const STATE_PATH = join(homedir(), ".hodlmm-il-tracker.json");
const MAX_HISTORY = 1000; // history entries cap

// ─── Output ──────────────────────────────────────────────────────────────
function output(status: string, action: string, data: any, error: any = null) {
  console.log(JSON.stringify({ status, action, data, error }));
}

function log(...args: any[]) {
  console.error("[il-tracker]", ...args);
}

// ─── Types ───────────────────────────────────────────────────────────────
interface BinData {
  bin_id: number;
  reserve_x: string;
  reserve_y: string;
  userLiquidity?: number;
  price?: number;
}

interface PoolMeta {
  pool_id: string;
  active_bin: number;
  token_x: string;
  token_y: string;
  bin_step: number;
}

interface EntrySnapshot {
  poolId: string;
  snapshotAt: string;
  activeBinAtEntry: number;
  priceAtEntry: number; // active bin price at entry
  totalEntryX: string; // BigInt string — token X deposited
  totalEntryY: string; // BigInt string — token Y deposited
  entryValueInY: string; // BigInt string — total value denominated in Y at entry price
  bins: { bin_id: number; reserve_x: string; reserve_y: string; price: number }[];
}

interface ILReading {
  poolId: string;
  timestamp: string;
  activeBin: number;
  currentPrice: number;
  entryPrice: number;
  priceChangePercent: number;
  // Current LP state
  currentX: string;
  currentY: string;
  lpValueInY: string; // current LP value in Y terms
  // HODL comparison
  hodlValueInY: string; // what entry tokens would be worth now
  // IL
  ilAbsoluteY: string; // LP value - HODL value (negative = loss)
  ilPercent: number; // IL as percentage of HODL value
  // Fees (if baseline available from range-keeper)
  estimatedFeesX: string;
  estimatedFeesY: string;
  netPnlY: string; // LP value + fees - HODL value
  netPnlPercent: number;
}

interface HistoryEntry {
  poolId: string;
  timestamp: string;
  activeBin: number;
  currentPrice: number;
  ilPercent: number;
  netPnlPercent: number;
  lpValueInY: string;
  hodlValueInY: string;
}

interface TrackerState {
  entries: Record<string, EntrySnapshot>; // poolId -> snapshot
  history: HistoryEntry[];
}

// ─── State Management ────────────────────────────────────────────────────
function loadState(): TrackerState {
  try {
    if (existsSync(STATE_PATH)) {
      return JSON.parse(readFileSync(STATE_PATH, "utf-8"));
    }
  } catch {}
  return { entries: {}, history: [] };
}

function saveState(state: TrackerState): void {
  if (state.history.length > MAX_HISTORY) {
    state.history = state.history.slice(-MAX_HISTORY);
  }
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

// ─── API Layer ───────────────────────────────────────────────────────────
async function fetchJson(url: string): Promise<any> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!r.ok) return null;
    return r.json();
  } catch {
    return null;
  }
}

async function fetchAllPools(): Promise<PoolMeta[]> {
  const data = await fetchJson(`${HODLMM_API}/pools`);
  return data?.pools || [];
}

async function fetchPoolBins(poolId: string): Promise<{ active_bin_id: number; bins: BinData[] } | null> {
  return fetchJson(`${HODLMM_API}/bins/${poolId}`);
}

async function fetchUserPositions(poolId: string, address: string): Promise<BinData[]> {
  const data = await fetchJson(
    `${HODLMM_APP_API}/api/app/v1/users/${address}/positions/${poolId}/bins`
  );
  if (!data?.bins) return [];
  return data.bins.map((b: any) => ({
    bin_id: parseInt(b.bin_id),
    reserve_x: String(b.reserve_x !== undefined && b.reserve_x !== null ? b.reserve_x : Math.floor(b.userLiquidity || 0)),
    reserve_y: String(b.reserve_y !== undefined && b.reserve_y !== null ? b.reserve_y : "0"),
    userLiquidity: b.userLiquidity || 0,
    price: b.price || 0,
  }));
}

async function fetchStxBalance(address: string): Promise<number> {
  const data = await fetchJson(`${HIRO_API}/extended/v1/address/${address}/stx`);
  return data ? parseInt(data.balance || "0") / 1e6 : 0;
}

// ─── Price helpers ───────────────────────────────────────────────────────
// Get the price at the active bin from pool bin data
async function getActiveBinPrice(poolId: string): Promise<number> {
  const poolBins = await fetchPoolBins(poolId);
  if (!poolBins?.bins) return 0;
  const activeBin = poolBins.bins.find((b) => b.bin_id === poolBins.active_bin_id);
  return activeBin?.price || 0;
}

// Calculate total value in Y terms: X * price + Y
function valueInY(totalX: bigint, totalY: bigint, price: number): bigint {
  if (price <= 0) return totalY;
  // price is X/Y ratio (how many Y per 1 X)
  // Use fixed-point: multiply by 1e8 for precision, then divide back
  const PRECISION = 100_000_000n;
  const priceBig = BigInt(Math.round(price * Number(PRECISION)));
  return (totalX * priceBig) / PRECISION + totalY;
}

// ─── IL Calculation ──────────────────────────────────────────────────────
function calculateIL(
  entry: EntrySnapshot,
  currentBins: BinData[],
  currentPrice: number,
  activeBin: number
): ILReading {
  const entryX = BigInt(entry.totalEntryX);
  const entryY = BigInt(entry.totalEntryY);

  // Current LP value
  let currentX = 0n;
  let currentY = 0n;
  for (const bin of currentBins) {
    currentX += BigInt(bin.reserve_x || "0");
    currentY += BigInt(bin.reserve_y || "0");
  }

  // Values in Y terms
  const lpValue = valueInY(currentX, currentY, currentPrice);
  const hodlValue = valueInY(entryX, entryY, currentPrice);

  // IL calculation
  const ilAbsolute = lpValue - hodlValue; // negative = loss
  const ilPercent = hodlValue > 0n
    ? Number((ilAbsolute * 10000n) / hodlValue) / 100
    : 0;

  // Fee estimation: growth above entry amounts (simple heuristic)
  // Fees accumulate as reserve increases beyond deposit
  let feesX = 0n;
  let feesY = 0n;
  for (const currentBin of currentBins) {
    const entryBin = entry.bins.find((e) => e.bin_id === currentBin.bin_id);
    if (entryBin) {
      const cx = BigInt(currentBin.reserve_x || "0");
      const cy = BigInt(currentBin.reserve_y || "0");
      const ex = BigInt(entryBin.reserve_x);
      const ey = BigInt(entryBin.reserve_y);
      if (cx > ex) feesX += cx - ex;
      if (cy > ey) feesY += cy - ey;
    }
  }

  const feeValue = valueInY(feesX, feesY, currentPrice);
  const netPnl = ilAbsolute + feeValue; // IL + fees
  const netPnlPercent = hodlValue > 0n
    ? Number((netPnl * 10000n) / hodlValue) / 100
    : 0;

  const priceChangePercent = entry.priceAtEntry > 0
    ? ((currentPrice - entry.priceAtEntry) / entry.priceAtEntry) * 100
    : 0;

  return {
    poolId: entry.poolId,
    timestamp: new Date().toISOString(),
    activeBin,
    currentPrice,
    entryPrice: entry.priceAtEntry,
    priceChangePercent: Math.round(priceChangePercent * 100) / 100,
    currentX: String(currentX),
    currentY: String(currentY),
    lpValueInY: String(lpValue),
    hodlValueInY: String(hodlValue),
    ilAbsoluteY: String(ilAbsolute),
    ilPercent: Math.round(ilPercent * 100) / 100,
    estimatedFeesX: String(feesX),
    estimatedFeesY: String(feesY),
    netPnlY: String(netPnl),
    netPnlPercent: Math.round(netPnlPercent * 100) / 100,
  };
}

// ─── Snapshot helper ─────────────────────────────────────────────────────
async function takeSnapshot(
  poolId: string,
  address: string,
  pools: PoolMeta[]
): Promise<EntrySnapshot | null> {
  const poolMeta = pools.find((p) => p.pool_id === poolId);
  if (!poolMeta) return null;

  const userBins = await fetchUserPositions(poolId, address);
  if (userBins.length === 0) return null;

  const price = await getActiveBinPrice(poolId);
  if (price <= 0) return null;

  let totalX = 0n;
  let totalY = 0n;
  const binSnapshots: EntrySnapshot["bins"] = [];

  for (const bin of userBins) {
    const rx = BigInt(bin.reserve_x || "0");
    const ry = BigInt(bin.reserve_y || "0");
    totalX += rx;
    totalY += ry;
    binSnapshots.push({
      bin_id: bin.bin_id,
      reserve_x: String(rx),
      reserve_y: String(ry),
      price: bin.price || 0,
    });
  }

  const entryValue = valueInY(totalX, totalY, price);

  return {
    poolId,
    snapshotAt: new Date().toISOString(),
    activeBinAtEntry: poolMeta.active_bin,
    priceAtEntry: price,
    totalEntryX: String(totalX),
    totalEntryY: String(totalY),
    entryValueInY: String(entryValue),
    bins: binSnapshots,
  };
}

// ─── CLI ─────────────────────────────────────────────────────────────────
const program = new Command();
program
  .name("hodlmm-il-tracker")
  .description("Impermanent loss tracker for HODLMM concentrated-liquidity positions");

// ── doctor ──────────────────────────────────────────────────────────────
program
  .command("doctor")
  .description("Check wallet, HODLMM API, and position availability")
  .action(async () => {
    const stxAddress = process.env.STX_ADDRESS || "";
    const checks: any = {
      hodlmmApi: false,
      pools: [],
      stxBalance: 0,
      positions: [],
      stateExists: existsSync(STATE_PATH),
      trackedPools: 0,
      historyEntries: 0,
    };

    const pools = await fetchAllPools();
    if (pools.length > 0) {
      checks.hodlmmApi = true;
      checks.pools = pools.map((p) => ({
        poolId: p.pool_id,
        activeBin: p.active_bin,
        binStep: p.bin_step,
        tokenX: p.token_x,
        tokenY: p.token_y,
      }));
    }

    if (stxAddress) {
      checks.stxBalance = await fetchStxBalance(stxAddress);

      const posResults = await Promise.allSettled(
        pools.map(async (pool) => {
          const bins = await fetchUserPositions(pool.pool_id, stxAddress);
          if (bins.length > 0) {
            return {
              poolId: pool.pool_id,
              bins: bins.length,
              activeBin: pool.active_bin,
            };
          }
          return null;
        })
      );

      checks.positions = posResults
        .filter(
          (r): r is PromiseFulfilledResult<any> =>
            r.status === "fulfilled" && r.value !== null
        )
        .map((r) => r.value);
    } else {
      checks.note = "Set STX_ADDRESS env var for full diagnostics";
    }

    const state = loadState();
    checks.trackedPools = Object.keys(state.entries).length;
    checks.historyEntries = state.history.length;

    checks.commands = [
      "doctor",
      "snapshot --pool dlmm_1",
      "status",
      "status --pool dlmm_1",
      "run",
      "history",
      "history --pool dlmm_1",
    ];

    output("success", "doctor", checks);
  });

// ── snapshot ─────────────────────────────────────────────────────────────
program
  .command("snapshot")
  .description("Record current position as IL baseline (entry point)")
  .option("--pool <id>", "Pool to snapshot (default: all with positions)")
  .option("--force", "Overwrite existing snapshot")
  .action(async (opts) => {
    const stxAddress = process.env.STX_ADDRESS;
    if (!stxAddress) {
      output("blocked", "snapshot", null, "STX_ADDRESS env var required.");
      return;
    }

    const state = loadState();
    const pools = await fetchAllPools();
    const poolIds = opts.pool ? [opts.pool] : pools.map((p) => p.pool_id);
    const results: any[] = [];

    const snapResults = await Promise.allSettled(
      poolIds.map(async (poolId) => {
        return { poolId, snapshot: await takeSnapshot(poolId, stxAddress!, pools) };
      })
    );

    for (const result of snapResults) {
      if (result.status !== "fulfilled" || !result.value.snapshot) continue;
      const { poolId, snapshot } = result.value;

      if (state.entries[poolId] && !opts.force) {
        results.push({
          poolId,
          action: "skipped",
          reason: "snapshot exists — use --force to overwrite",
          existingSnapshotAt: state.entries[poolId].snapshotAt,
        });
        continue;
      }

      state.entries[poolId] = snapshot;
      results.push({
        poolId,
        action: opts.force ? "overwritten" : "created",
        snapshotAt: snapshot.snapshotAt,
        activeBin: snapshot.activeBinAtEntry,
        price: snapshot.priceAtEntry,
        totalEntryX: snapshot.totalEntryX,
        totalEntryY: snapshot.totalEntryY,
        entryValueInY: snapshot.entryValueInY,
        binsTracked: snapshot.bins.length,
      });
    }

    saveState(state);

    output("success", "snapshot", {
      poolsProcessed: results.length,
      snapshots: results,
    });
  });

// ── status ──────────────────────────────────────────────────────────────
program
  .command("status")
  .description("Show current IL for all tracked positions")
  .option("--pool <id>", "Specific pool (default: all tracked)")
  .action(async (opts) => {
    const stxAddress = process.env.STX_ADDRESS;
    if (!stxAddress) {
      output("blocked", "status", null, "STX_ADDRESS env var required.");
      return;
    }

    const state = loadState();
    const pools = await fetchAllPools();
    const trackedIds = opts.pool
      ? [opts.pool]
      : Object.keys(state.entries);

    if (trackedIds.length === 0) {
      output("success", "status", {
        note: "No positions tracked. Run `snapshot` first to establish an entry baseline.",
        positions: [],
      });
      return;
    }

    // Fetch all positions and prices in parallel
    const fetchResults = await Promise.allSettled(
      trackedIds.map(async (poolId) => {
        const entry = state.entries[poolId];
        if (!entry) return null;

        const poolMeta = pools.find((p) => p.pool_id === poolId);
        if (!poolMeta) return null;

        const [userBins, price] = await Promise.all([
          fetchUserPositions(poolId, stxAddress!),
          getActiveBinPrice(poolId),
        ]);

        if (userBins.length === 0 || price <= 0) return null;

        return { poolId, entry, userBins, price, activeBin: poolMeta.active_bin };
      })
    );

    const readings: ILReading[] = [];

    for (const result of fetchResults) {
      if (result.status !== "fulfilled" || !result.value) continue;
      const { entry, userBins, price, activeBin } = result.value;

      const reading = calculateIL(entry, userBins, price, activeBin);
      readings.push(reading);
    }

    // Classify severity
    const summary = {
      positionsTracked: readings.length,
      healthy: readings.filter((r) => r.ilPercent > -1).length,
      mild: readings.filter((r) => r.ilPercent <= -1 && r.ilPercent > -5).length,
      severe: readings.filter((r) => r.ilPercent <= -5).length,
      profitableAfterFees: readings.filter((r) => r.netPnlPercent > 0).length,
    };

    output("success", "status", {
      summary,
      positions: readings.map((r) => ({
        poolId: r.poolId,
        priceChange: `${r.priceChangePercent > 0 ? "+" : ""}${r.priceChangePercent}%`,
        ilPercent: `${r.ilPercent}%`,
        netPnlPercent: `${r.netPnlPercent > 0 ? "+" : ""}${r.netPnlPercent}%`,
        severity: r.ilPercent > -1 ? "healthy" : r.ilPercent > -5 ? "mild" : "severe",
        recommendation:
          r.ilPercent <= -5
            ? "consider_recenter"
            : r.ilPercent <= -1
              ? "monitor"
              : "hold",
        detail: r,
      })),
    });
  });

// ── run ─────────────────────────────────────────────────────────────────
program
  .command("run")
  .description("Full cycle: snapshot new positions, report IL, record history")
  .action(async () => {
    const stxAddress = process.env.STX_ADDRESS;
    if (!stxAddress) {
      output("blocked", "run", null, "STX_ADDRESS env var required.");
      return;
    }

    const state = loadState();
    const pools = await fetchAllPools();
    const newSnapshots: string[] = [];
    const readings: ILReading[] = [];

    // 1. Discover positions across all pools in parallel
    const posResults = await Promise.allSettled(
      pools.map(async (pool) => {
        const bins = await fetchUserPositions(pool.pool_id, stxAddress!);
        if (bins.length === 0) return null;
        return { poolId: pool.pool_id, bins };
      })
    );

    const poolsWithPositions = posResults
      .filter(
        (r): r is PromiseFulfilledResult<{ poolId: string; bins: BinData[] }> =>
          r.status === "fulfilled" && r.value !== null
      )
      .map((r) => r.value);

    // 2. For pools without entry snapshots, create them
    for (const { poolId } of poolsWithPositions) {
      if (!state.entries[poolId]) {
        const snapshot = await takeSnapshot(poolId, stxAddress, pools);
        if (snapshot) {
          state.entries[poolId] = snapshot;
          newSnapshots.push(poolId);
          log(`New snapshot recorded for ${poolId}`);
        }
      }
    }

    // 3. Calculate IL for all tracked positions (parallel)
    const ilResults = await Promise.allSettled(
      poolsWithPositions
        .filter(({ poolId }) => state.entries[poolId] && !newSnapshots.includes(poolId))
        .map(async ({ poolId, bins }) => {
          const entry = state.entries[poolId];
          const poolMeta = pools.find((p) => p.pool_id === poolId);
          if (!poolMeta) return null;

          const price = await getActiveBinPrice(poolId);
          if (price <= 0) return null;

          return calculateIL(entry, bins, price, poolMeta.active_bin);
        })
    );

    for (const result of ilResults) {
      if (result.status !== "fulfilled" || !result.value) continue;
      const reading = result.value;
      readings.push(reading);

      // Record to history
      state.history.push({
        poolId: reading.poolId,
        timestamp: reading.timestamp,
        activeBin: reading.activeBin,
        currentPrice: reading.currentPrice,
        ilPercent: reading.ilPercent,
        netPnlPercent: reading.netPnlPercent,
        lpValueInY: reading.lpValueInY,
        hodlValueInY: reading.hodlValueInY,
      });
    }

    saveState(state);

    // 4. Build alerts
    const alerts: string[] = [];
    for (const r of readings) {
      if (r.ilPercent <= -5) {
        alerts.push(
          `${r.poolId}: IL at ${r.ilPercent}% — consider recenter or exit`
        );
      } else if (r.ilPercent <= -2 && r.netPnlPercent < 0) {
        alerts.push(
          `${r.poolId}: IL at ${r.ilPercent}%, fees not covering loss (net ${r.netPnlPercent}%)`
        );
      }
    }

    output("success", "run", {
      poolsScanned: pools.length,
      positionsFound: poolsWithPositions.length,
      newSnapshotsCreated: newSnapshots,
      ilReadings: readings.length,
      alerts,
      positions: readings.map((r) => ({
        poolId: r.poolId,
        ilPercent: r.ilPercent,
        netPnlPercent: r.netPnlPercent,
        recommendation:
          r.ilPercent <= -5
            ? "consider_recenter"
            : r.ilPercent <= -1
              ? "monitor"
              : "hold",
      })),
    });
  });

// ── history ─────────────────────────────────────────────────────────────
program
  .command("history")
  .description("Show IL trend over time")
  .option("--pool <id>", "Filter by pool")
  .option("--limit <n>", "Number of entries", "30")
  .action(async (opts) => {
    const state = loadState();
    let entries = state.history;

    if (opts.pool) {
      entries = entries.filter((e) => e.poolId === opts.pool);
    }

    const limit = parseInt(opts.limit) || 30;
    entries = entries.slice(-limit);

    // Compute trend if enough data
    let trend: any = null;
    if (entries.length >= 2) {
      const first = entries[0];
      const last = entries[entries.length - 1];
      trend = {
        periodStart: first.timestamp,
        periodEnd: last.timestamp,
        ilChange: Math.round((last.ilPercent - first.ilPercent) * 100) / 100,
        priceChange: last.currentPrice - first.currentPrice,
        direction: last.ilPercent < first.ilPercent ? "worsening" : "improving",
        readings: entries.length,
      };
    }

    output("success", "history", {
      totalEntries: state.history.length,
      trackedPools: Object.keys(state.entries).length,
      entries: opts.pool ? entries : Object.keys(state.entries).map((poolId) => {
        const poolEntries = entries.filter((e) => e.poolId === poolId);
        const latest = poolEntries[poolEntries.length - 1];
        return {
          poolId,
          readings: poolEntries.length,
          latestIL: latest?.ilPercent ?? null,
          latestNetPnl: latest?.netPnlPercent ?? null,
          snapshotAt: state.entries[poolId]?.snapshotAt,
        };
      }),
      trend,
    });
  });

// ── install-packs ───────────────────────────────────────────────────────
program
  .command("install-packs")
  .description("Install dependency packs (no external packs required)")
  .option("--pack <name>", "Pack to install", "all")
  .action(async () => {
    output("success", "install-packs", {
      installed: [],
      note: "No external packs required. Uses built-in fetch and Commander.js.",
    });
  });

program.parse(process.argv);
