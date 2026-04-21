#!/usr/bin/env bun
/**
 * hodlmm-bin-optimizer — volatility-driven bin-width recommender for HODLMM LPs.
 *
 * Pairs with hodlmm-range-keeper: range-keeper takes a fixed bin-radius from
 * config and moves liquidity to the active bin. bin-optimizer derives the
 * *right* bin-radius from observed active-bin volatility, so the operator
 * stops guessing "how wide should my range be."
 *
 * Commands:
 *   doctor     — env + API check, no side effects
 *   sample     — record current active_bin to local history (cron-friendly)
 *   bootstrap  — backfill history from Hiro contract events (one-shot)
 *   suggest    — compute optimal bin-radius from accumulated history
 *   config     — emit range-keeper-compatible JSON config
 *   history    — dump observation history for a pool
 *   install-packs — no external deps, returns ok
 */

import { Command } from "commander";
import { readFileSync, writeFileSync, existsSync, renameSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// ─── Config ──────────────────────────────────────────────────────────────
const HODLMM_API = "https://bff.bitflowapis.finance/api/quotes/v1";
const HIRO_API = "https://api.hiro.so";

const STATE_PATH =
  process.env.HODLMM_BIN_OPTIMIZER_STATE ||
  join(homedir(), ".hodlmm-bin-optimizer.json");

const MAX_SAMPLES = 10_000; // hard cap per pool to keep state file bounded
const MIN_RADIUS = 2;
const MAX_RADIUS = 50;
const DEFAULT_LOOKBACK_HOURS = 24;
const DEFAULT_COVERAGE = 0.9;
const DEFAULT_CAPITAL_STX = 10_000;

// z-scores for one-sided coverage targets (symmetric two-sided = 1 - (1-cov)/2)
const Z_TABLE: Record<string, number> = {
  "0.80": 1.28,
  "0.85": 1.44,
  "0.90": 1.65,
  "0.95": 1.96,
  "0.99": 2.58,
};

// ─── Types ───────────────────────────────────────────────────────────────
interface Sample {
  ts: string;
  active_bin: number;
  price: string;
  source: "sample" | "bootstrap";
}

interface PoolHistory {
  samples: Sample[];
  lastSuggest?: SuggestResult;
}

interface OptimizerState {
  pools: Record<string, PoolHistory>;
  version: 1;
}

interface PoolMeta {
  pool_id: string;
  pool_name: string;
  pool_symbol: string;
  active_bin: number;
  bin_step: number;
  token_x: string;
  token_y: string;
  x_total_fee_bps: string;
  y_total_fee_bps: string;
  active: boolean;
  core_address: string;
  pool_token: string;
}

interface Bin {
  bin_id: number;
  reserve_x: string;
  reserve_y: string;
  price: string;
  liquidity: string;
}

interface PoolBins {
  success: boolean;
  pool_id: string;
  bins: Bin[];
  active_bin_id?: number;
}

interface VolatilityStats {
  samples: number;
  lookback_hours: number;
  mean_bin_id: number;
  bin_id_std: number;
  p5_bin_id: number;
  p95_bin_id: number;
  min_bin_id: number;
  max_bin_id: number;
  max_excursion: number;
}

interface SuggestResult {
  pool_id: string;
  current_active_bin: number;
  volatility: VolatilityStats;
  recommendation: {
    coverage_target: number;
    bin_radius: number;
    bin_count: number;
    min_bin_id: number;
    max_bin_id: number;
    expected_coverage_pct: number;
    capital_per_bin_stx: number;
    capital_per_bin_micro_stx: number;
    total_capital_stx: number;
  };
  range_keeper_config: {
    poolId: string;
    centerBinOffset: number;
    binRadius: number;
    stxAmountPerBin: number;
  };
  confidence: "high" | "medium" | "low";
  reason: string;
  computed_at: string;
}

type OutputStatus = "success" | "error" | "blocked";

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
  console.error("[bin-optimizer]", ...args);
}

function loadState(): OptimizerState {
  if (!existsSync(STATE_PATH)) return { version: 1, pools: {} };
  try {
    const raw = readFileSync(STATE_PATH, "utf8");
    const parsed = JSON.parse(raw) as OptimizerState;
    if (!parsed.pools) return { version: 1, pools: {} };
    return parsed;
  } catch (e) {
    log(`state load failed (${(e as Error).message}), starting fresh`);
    return { version: 1, pools: {} };
  }
}

function saveState(state: OptimizerState): void {
  // Atomic write: tmp → rename. Protects against torn JSON on SIGTERM/OOM
  // if a cron run overlaps with a concurrent `suggest` invocation.
  const tmp = `${STATE_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, STATE_PATH);
}

// ─── HTTP ────────────────────────────────────────────────────────────────
async function fetchJson<T>(url: string, timeoutMs = 15_000): Promise<T> {
  let resp: Response;
  try {
    resp = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new Error(`network error for ${url}: ${(e as Error).message}`);
  }
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} for ${url}`);
  }
  try {
    return (await resp.json()) as T;
  } catch (e) {
    throw new Error(`parse error for ${url}: ${(e as Error).message}`);
  }
}

async function fetchAllPools(): Promise<PoolMeta[]> {
  const d = await fetchJson<{ pools?: PoolMeta[] }>(`${HODLMM_API}/pools`);
  return Array.isArray(d.pools) ? d.pools : [];
}

async function fetchPoolMeta(poolId: string): Promise<PoolMeta | null> {
  const pools = await fetchAllPools();
  return pools.find((p) => p.pool_id === poolId) ?? null;
}

async function fetchCurrentActiveBin(
  poolId: string,
): Promise<{ active_bin: number; price: string } | null> {
  const meta = await fetchPoolMeta(poolId);
  if (!meta) return null;
  // Prefer `/bins/:poolId` active_bin_id because the `/bins` endpoint refreshes
  // on every swap-emitting block (most authoritative). Fall back to the
  // `/pools` list's `active_bin` (cached at longer interval) only when the
  // `/bins` response omits the field — divergence between the two during
  // high-volatility periods is a sampling-interval artifact, not protocol
  // state; worst case the sample lags by one list-refresh cycle.
  const binsData = await fetchJson<PoolBins>(`${HODLMM_API}/bins/${poolId}`);
  const activeBinId =
    binsData.active_bin_id !== undefined ? binsData.active_bin_id : meta.active_bin;
  const binRow = binsData.bins.find((b) => b.bin_id === activeBinId);
  return { active_bin: activeBinId, price: binRow?.price ?? "0" };
}

// ─── Volatility math ─────────────────────────────────────────────────────
function windowSamples(samples: Sample[], lookbackHours: number): Sample[] {
  const cutoff = Date.now() - lookbackHours * 3600_000;
  return samples.filter((s) => new Date(s.ts).getTime() >= cutoff);
}

function computeVolatility(samples: Sample[], lookbackHours: number): VolatilityStats {
  if (samples.length === 0) {
    return {
      samples: 0,
      lookback_hours: lookbackHours,
      mean_bin_id: 0,
      bin_id_std: 0,
      p5_bin_id: 0,
      p95_bin_id: 0,
      min_bin_id: 0,
      max_bin_id: 0,
      max_excursion: 0,
    };
  }
  const bins = samples.map((s) => s.active_bin).sort((a, b) => a - b);
  const mean = bins.reduce((a, b) => a + b, 0) / bins.length;
  const variance = bins.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, bins.length - 1);
  const std = Math.sqrt(variance);
  const pctl = (p: number): number => {
    const idx = Math.min(bins.length - 1, Math.max(0, Math.floor((p / 100) * (bins.length - 1))));
    return bins[idx];
  };
  const p5 = pctl(5);
  const p95 = pctl(95);
  const min = bins[0];
  const max = bins[bins.length - 1];
  // Max excursion from mean
  const excursion = Math.max(Math.abs(max - mean), Math.abs(min - mean));
  return {
    samples: samples.length,
    lookback_hours: lookbackHours,
    mean_bin_id: Number(mean.toFixed(3)),
    bin_id_std: Number(std.toFixed(3)),
    p5_bin_id: p5,
    p95_bin_id: p95,
    min_bin_id: min,
    max_bin_id: max,
    max_excursion: Number(excursion.toFixed(2)),
  };
}

function zFor(coverage: number): number {
  const key = coverage.toFixed(2);
  if (Z_TABLE[key] !== undefined) return Z_TABLE[key];
  // Unlisted coverage: linearly interpolate between the two nearest Z_TABLE
  // entries. Log a stderr note so operators see the estimate is derived.
  const keys = Object.keys(Z_TABLE)
    .map((k) => parseFloat(k))
    .sort((a, b) => a - b);
  if (coverage <= keys[0]) return Z_TABLE[keys[0].toFixed(2)];
  if (coverage >= keys[keys.length - 1]) return Z_TABLE[keys[keys.length - 1].toFixed(2)];
  for (let i = 0; i < keys.length - 1; i++) {
    if (coverage >= keys[i] && coverage <= keys[i + 1]) {
      const lo = keys[i];
      const hi = keys[i + 1];
      const zLo = Z_TABLE[lo.toFixed(2)];
      const zHi = Z_TABLE[hi.toFixed(2)];
      const frac = (coverage - lo) / (hi - lo);
      const interp = zLo + frac * (zHi - zLo);
      log(`zFor: coverage ${coverage} interpolated between ${lo}(z=${zLo}) and ${hi}(z=${zHi}) → ${interp.toFixed(3)}`);
      return interp;
    }
  }
  return 1.65;
}

function classifyConfidence(
  samples: number,
  lookbackHours: number,
  binRadius: number,
  expectedCoveragePct: number,
  coverageTarget: number,
): "high" | "medium" | "low" {
  // `suggest` already early-returns at <5 samples, so this runs only with ≥5.
  // Downgrade if the recommendation can't actually meet the coverage target:
  // (a) bin radius was capped at MAX_RADIUS, or
  // (b) empirical coverage at the deployed center falls >20% short of target.
  // Both flag that the underlying volatility (or bootstrap-contaminated samples)
  // exceeds what this configuration can cover — sample density alone is misleading.
  const coverageShortfall = coverageTarget * 100 - expectedCoveragePct;
  const capHit = binRadius >= MAX_RADIUS;
  const coverageTooLow = coverageShortfall > coverageTarget * 100 * 0.2;
  if (capHit || coverageTooLow) return "low";
  const perHour = samples / Math.max(1, lookbackHours);
  if (samples >= 200 && perHour >= 8) return "high";
  if (samples >= 50 && perHour >= 2) return "medium";
  return "low";
}

function computeRecommendation(
  currentActiveBin: number,
  vol: VolatilityStats,
  coverage: number,
  capitalStx: number,
  samples: Sample[],
): SuggestResult["recommendation"] {
  const z = zFor(coverage);
  // Raw radius = z × std, with floor for zero-std (no observed movement yet)
  const rawRadius = z * Math.max(vol.bin_id_std, 0.5);
  // Also ensure radius covers the max observed excursion × safety factor
  const excursionRadius = vol.max_excursion * 1.1;
  const targetRadius = Math.max(rawRadius, excursionRadius);
  const binRadius = Math.min(MAX_RADIUS, Math.max(MIN_RADIUS, Math.ceil(targetRadius)));
  const binCount = binRadius * 2 + 1;
  const minBinId = currentActiveBin - binRadius;
  const maxBinId = currentActiveBin + binRadius;
  // Expected coverage = direct count of historical samples that fell within
  // ±bin_radius of the **deployed center** (the current active bin). Measuring
  // against `currentActiveBin` instead of `vol.mean_bin_id` is what the
  // recommendation actually describes: the deployed range will be centered on
  // the active bin, so coverage must be measured there. Using mean would
  // overstate coverage whenever price has drifted from the historical center.
  let inRange = 0;
  for (const s of samples) {
    if (Math.abs(s.active_bin - currentActiveBin) <= binRadius) inRange += 1;
  }
  const expectedCoveragePct =
    samples.length > 0 ? (inRange / samples.length) * 100 : 0;
  const capitalPerBinMicro = Math.floor((capitalStx * 1_000_000) / binCount); // microSTX, single floor
  return {
    coverage_target: coverage,
    bin_radius: binRadius,
    bin_count: binCount,
    min_bin_id: minBinId,
    max_bin_id: maxBinId,
    expected_coverage_pct: Number(expectedCoveragePct.toFixed(2)),
    capital_per_bin_stx: Number((capitalPerBinMicro / 1_000_000).toFixed(4)),
    capital_per_bin_micro_stx: capitalPerBinMicro,
    total_capital_stx: capitalStx,
  };
}

// ─── Hiro bootstrap (historical active-bin reconstruction) ──────────────
interface HiroEvent {
  event_index: number;
  event_type: string;
  tx_id: string;
  contract_log?: {
    contract_id: string;
    value?: { hex?: string; repr?: string };
    topic?: string;
  };
}

interface HiroEventsResponse {
  results: HiroEvent[];
  offset?: number;
  limit?: number;
  total?: number;
}

async function hiroBootstrap(
  poolContract: string,
  hours: number,
): Promise<Sample[]> {
  // Fetch recent contract events; pagination up to a safety cap.
  // `hours` is currently advisory — Hiro's /events list doesn't return
  // per-event `block_time`, so we can't cut off by on-chain age yet. The
  // parameter is preserved for the v2 enrichment path that adds a per-tx
  // fetch to get `block_time`.
  const limit = 50;
  const maxPages = 20; // 1000 events ceiling
  const samples: Sample[] = [];
  void hours; // see above — reserved for v2 block_time cutoff
  let offset = 0;

  const headers: Record<string, string> = {};
  if (process.env.HIRO_API_KEY) headers["x-api-key"] = process.env.HIRO_API_KEY;

  for (let page = 0; page < maxPages; page++) {
    const url = `${HIRO_API}/extended/v1/contract/${poolContract}/events?limit=${limit}&offset=${offset}`;
    let data: HiroEventsResponse;
    try {
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
      if (!r.ok) {
        log(`hiro ${r.status} at offset ${offset}, stopping bootstrap`);
        break;
      }
      data = (await r.json()) as HiroEventsResponse;
    } catch (e) {
      log(`hiro error: ${(e as Error).message}`);
      break;
    }
    if (!data.results || data.results.length === 0) break;
    // Without a direct timestamp per event, we derive block_time via tx lookup.
    // For a first version, record the event order; the 'suggest' step can
    // treat these as equal-weighted regardless of timing.
    for (const ev of data.results) {
      const repr = ev.contract_log?.value?.repr || "";
      // Anchor to a Clarity tuple entry for the *current* active bin.
      // Accepts `(active-bin u499)` / `(active-bin 499)` / `(active-bin-id u499)`.
      // Rejects fields like `previous-active-bin` / `active-bin-before`.
      const match = repr.match(/\((?:active-bin|active-bin-id)\s+u?(-?\d+)\)/);
      if (match) {
        samples.push({
          ts: new Date().toISOString(),
          active_bin: parseInt(match[1], 10),
          price: "0",
          source: "bootstrap",
        });
      }
    }
    offset += limit;
    if (data.results.length < limit) break;
  }
  return samples;
}

// ─── Commands ───────────────────────────────────────────────────────────
async function cmdDoctor(poolId: string | undefined): Promise<void> {
  const state = loadState();
  const trackedPools = Object.keys(state.pools);
  const issues: string[] = [];
  const info: Record<string, unknown> = {};
  try {
    const pools = await fetchAllPools();
    info.hodlmm_api = { reachable: true, pool_count: pools.length };
    if (poolId) {
      const meta = pools.find((p) => p.pool_id === poolId);
      if (!meta) issues.push(`pool_id ${poolId} not found in /pools`);
      else {
        info.target_pool = {
          pool_id: meta.pool_id,
          pool_name: meta.pool_name,
          active_bin: meta.active_bin,
          bin_step: meta.bin_step,
          core_address: meta.core_address,
          pool_token: meta.pool_token,
          active: meta.active,
        };
      }
    }
  } catch (e) {
    info.hodlmm_api = { reachable: false, error: (e as Error).message };
    issues.push("HODLMM API unreachable");
  }
  info.state = {
    path: STATE_PATH,
    tracked_pools: trackedPools,
    samples_total: trackedPools.reduce(
      (a: number, p: string) => a + (state.pools[p]?.samples?.length ?? 0),
      0,
    ),
  };
  info.hiro_api_key_set = Boolean(process.env.HIRO_API_KEY);
  const status: OutputStatus = issues.length > 0 ? "blocked" : "success";
  output({
    status,
    action: "doctor",
    data: { checks: info, issues },
    error:
      issues.length > 0
        ? { code: "DOCTOR_BLOCKED", message: issues.join("; ") }
        : null,
  });
}

async function cmdSample(poolId: string): Promise<void> {
  const state = loadState();
  const current = await fetchCurrentActiveBin(poolId);
  if (!current) {
    output({
      status: "error",
      action: "sample",
      data: null,
      error: { code: "POOL_NOT_FOUND", message: `pool_id ${poolId} not found` },
    });
    return;
  }
  const pool = state.pools[poolId] ?? { samples: [] };
  pool.samples.push({
    ts: new Date().toISOString(),
    active_bin: current.active_bin,
    price: current.price,
    source: "sample",
  });
  if (pool.samples.length > MAX_SAMPLES) {
    pool.samples = pool.samples.slice(-MAX_SAMPLES);
  }
  state.pools[poolId] = pool;
  saveState(state);
  output({
    status: "success",
    action: "sample",
    data: {
      pool_id: poolId,
      active_bin: current.active_bin,
      price: current.price,
      total_samples: pool.samples.length,
    },
    error: null,
  });
}

async function cmdBootstrap(poolId: string, hours: number): Promise<void> {
  const meta = await fetchPoolMeta(poolId);
  if (!meta) {
    output({
      status: "error",
      action: "bootstrap",
      data: null,
      error: { code: "POOL_NOT_FOUND", message: `pool_id ${poolId} not found` },
    });
    return;
  }
  const bootstrapSamples = await hiroBootstrap(meta.core_address, hours);
  const state = loadState();
  const pool = state.pools[poolId] ?? { samples: [] };
  pool.samples = [...pool.samples, ...bootstrapSamples];
  if (pool.samples.length > MAX_SAMPLES) {
    pool.samples = pool.samples.slice(-MAX_SAMPLES);
  }
  state.pools[poolId] = pool;
  saveState(state);
  output({
    status: bootstrapSamples.length > 0 ? "success" : "blocked",
    action: "bootstrap",
    data: {
      pool_id: poolId,
      added: bootstrapSamples.length,
      total_samples: pool.samples.length,
      note:
        bootstrapSamples.length === 0
          ? "No active-bin events parsed from contract log. Run `sample` on a cron for organic data collection."
          : "Historical bootstrap parsed from contract events (equal-weighted, approximate).",
    },
    error:
      bootstrapSamples.length === 0
        ? {
            code: "BOOTSTRAP_EMPTY",
            message: "no active-bin events parsed",
            next: "schedule `sample` on a cron (every 5-15 min) to build organic history",
          }
        : null,
  });
}

async function cmdSuggest(
  poolId: string,
  lookbackHours: number,
  coverage: number,
  capitalStx: number,
): Promise<void> {
  const state = loadState();
  const pool = state.pools[poolId];
  const current = await fetchCurrentActiveBin(poolId);
  if (!current) {
    output({
      status: "error",
      action: "suggest",
      data: null,
      error: { code: "POOL_NOT_FOUND", message: `pool_id ${poolId} not found` },
    });
    return;
  }
  const samples = pool ? windowSamples(pool.samples, lookbackHours) : [];
  const vol = computeVolatility(samples, lookbackHours);
  if (vol.samples < 5) {
    output({
      status: "blocked",
      action: "suggest",
      data: {
        pool_id: poolId,
        current_active_bin: current.active_bin,
        volatility: vol,
      },
      error: {
        code: "INSUFFICIENT_HISTORY",
        message: `only ${vol.samples} samples in ${lookbackHours}h window; need ≥5 for a defensible recommendation`,
        next: `run \`sample --pool ${poolId}\` on a cron for several hours, or \`bootstrap --pool ${poolId} --hours ${lookbackHours}\` if HIRO_API_KEY is set`,
      },
    });
    return;
  }
  const rec = computeRecommendation(current.active_bin, vol, coverage, capitalStx, samples);
  const confidence = classifyConfidence(
    vol.samples,
    lookbackHours,
    rec.bin_radius,
    rec.expected_coverage_pct,
    rec.coverage_target,
  );
  const result: SuggestResult = {
    pool_id: poolId,
    current_active_bin: current.active_bin,
    volatility: vol,
    recommendation: rec,
    range_keeper_config: {
      poolId,
      centerBinOffset: 0,
      binRadius: rec.bin_radius,
      stxAmountPerBin: rec.capital_per_bin_micro_stx,
    },
    confidence,
    reason: `${vol.samples} samples over ${lookbackHours}h, std=${vol.bin_id_std}, excursion=${vol.max_excursion} bins → recommended radius ${rec.bin_radius} (z=${zFor(coverage)})`,
    computed_at: new Date().toISOString(),
  };
  // Persist last suggest for audit
  const poolState = state.pools[poolId] ?? { samples: [] };
  poolState.lastSuggest = result;
  state.pools[poolId] = poolState;
  saveState(state);
  output({ status: "success", action: "suggest", data: result, error: null });
}

async function cmdConfig(poolId: string): Promise<void> {
  const state = loadState();
  const pool = state.pools[poolId];
  if (!pool?.lastSuggest) {
    output({
      status: "blocked",
      action: "config",
      data: null,
      error: {
        code: "NO_SUGGEST_YET",
        message: `no stored suggest for pool ${poolId}`,
        next: `run \`suggest --pool ${poolId}\` first`,
      },
    });
    return;
  }
  output({
    status: "success",
    action: "config",
    data: {
      pool_id: poolId,
      range_keeper_config: pool.lastSuggest.range_keeper_config,
      computed_at: pool.lastSuggest.computed_at,
      confidence: pool.lastSuggest.confidence,
    },
    error: null,
  });
}

async function cmdHistory(poolId: string, limit: number): Promise<void> {
  const state = loadState();
  const pool = state.pools[poolId];
  if (!pool) {
    output({
      status: "success",
      action: "history",
      data: { pool_id: poolId, samples: [], total: 0 },
      error: null,
    });
    return;
  }
  const slice = pool.samples.slice(-limit);
  output({
    status: "success",
    action: "history",
    data: {
      pool_id: poolId,
      samples: slice,
      total: pool.samples.length,
      returned: slice.length,
    },
    error: null,
  });
}

async function cmdInstallPacks(): Promise<void> {
  output({
    status: "success",
    action: "install-packs",
    data: { packs: [], note: "no external packs required" },
    error: null,
  });
}

// ─── CLI wiring ─────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const program = new Command();
  program
    .name("hodlmm-bin-optimizer")
    .description(
      "Recommend optimal HODLMM bin-radius from observed active-bin volatility",
    );

  program
    .command("doctor")
    .description("Check API reachability, state, pool existence")
    .option("--pool <id>", "target pool id (e.g. dlmm_6)")
    .action(async (opts: { pool?: string }) => {
      await cmdDoctor(opts.pool);
    });

  program
    .command("sample")
    .description("Record current active_bin to local history")
    .requiredOption("--pool <id>", "pool id (e.g. dlmm_6)")
    .action(async (opts: { pool: string }) => {
      await cmdSample(opts.pool);
    });

  program
    .command("bootstrap")
    .description("Backfill history from Hiro contract events (one-shot)")
    .requiredOption("--pool <id>", "pool id")
    .option("--hours <n>", "lookback window in hours", "24")
    .action(async (opts: { pool: string; hours: string }) => {
      await cmdBootstrap(opts.pool, parseInt(opts.hours, 10));
    });

  program
    .command("suggest")
    .description("Compute recommended bin-radius from accumulated history")
    .requiredOption("--pool <id>", "pool id")
    .option("--lookback <hours>", "history window in hours", String(DEFAULT_LOOKBACK_HOURS))
    .option("--coverage <0-1>", "coverage target (0.80-0.99)", String(DEFAULT_COVERAGE))
    .option("--capital <stx>", "total STX to allocate", String(DEFAULT_CAPITAL_STX))
    .action(
      async (opts: { pool: string; lookback: string; coverage: string; capital: string }) => {
        const lookback = parseInt(opts.lookback, 10);
        const coverage = parseFloat(opts.coverage);
        const capital = parseFloat(opts.capital);
        if (!Number.isFinite(lookback) || lookback <= 0) {
          output({
            status: "error",
            action: "suggest",
            data: null,
            error: { code: "BAD_LOOKBACK", message: "--lookback must be a positive integer" },
          });
          return;
        }
        if (!Number.isFinite(coverage) || coverage < 0.8 || coverage > 0.99) {
          output({
            status: "error",
            action: "suggest",
            data: null,
            error: {
              code: "BAD_COVERAGE",
              message: "--coverage must be between 0.80 and 0.99 inclusive",
            },
          });
          return;
        }
        if (!Number.isFinite(capital) || capital <= 0) {
          output({
            status: "error",
            action: "suggest",
            data: null,
            error: { code: "BAD_CAPITAL", message: "--capital must be a positive number" },
          });
          return;
        }
        await cmdSuggest(opts.pool, lookback, coverage, capital);
      },
    );

  program
    .command("config")
    .description("Emit range-keeper-compatible config from last suggest")
    .requiredOption("--pool <id>", "pool id")
    .action(async (opts: { pool: string }) => {
      await cmdConfig(opts.pool);
    });

  program
    .command("history")
    .description("Dump observation history for a pool")
    .requiredOption("--pool <id>", "pool id")
    .option("--limit <n>", "most-recent N samples", "100")
    .action(async (opts: { pool: string; limit: string }) => {
      await cmdHistory(opts.pool, parseInt(opts.limit, 10));
    });

  program
    .command("install-packs")
    .description("No external packs required")
    .option("--pack <name>", "ignored", "all")
    .action(async () => {
      await cmdInstallPacks();
    });

  await program.parseAsync(process.argv);
}

// Commander exits with its own error messages on bad args
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
