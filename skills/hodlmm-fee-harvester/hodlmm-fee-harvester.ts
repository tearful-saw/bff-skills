#!/usr/bin/env bun
/**
 * hodlmm-fee-harvester — HODLMM LP Fee Estimation & Harvesting
 *
 * HODLMM auto-compounds swap fees into bin reserves. There is no separate
 * claim-fees function. This skill:
 *   1. Tracks deposit baselines per bin in a local ledger
 *   2. Compares current bin value against baseline to estimate accrued fees
 *   3. Harvests (withdraw + pocket growth + re-deposit) when profitable
 *
 * Commands:
 *   doctor   — check wallet, HODLMM API, positions
 *   scan     — estimate accrued fees per bin (read-only)
 *   harvest  — withdraw, extract fees, re-deposit principal
 *   history  — show past harvests from ledger
 */

import { Command } from "commander";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// ─── Config ───────────────────────────────────────────────────────────────
const HODLMM_API = "https://bff.bitflowapis.finance/api/quotes/v1";
const HODLMM_APP_API = "https://bff.bitflowapis.finance";
const HIRO_API = "https://api.hiro.so";

// Pool contracts for on-chain reads
const POOL_CONTRACTS: Record<string, string> = {
  dlmm_1: "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-sbtc-usdcx-v-1-bps-10",
  dlmm_3: "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-stx-usdcx-v-1-bps-10",
  dlmm_6: "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-stx-sbtc-v-1-bps-15",
};

const CORE_CONTRACT = "SP1PFR4V08H1RAZXREBGFFQ59WB739XM8VVGTFSEA.dlmm-core-v-1-1";

// Safety limits
const MIN_HARVEST_MULTIPLIER = 2; // fees must be >= 2x gas cost
const MAX_GAS_STX = 50;
const DEFAULT_GAS_ESTIMATE_STX = 2; // conservative per-tx gas estimate
const MIN_POSITION_SATS = 5_000; // ignore dust positions
const HODLMM_SLIPPAGE_PCT = 0.5;
const DEFAULT_BIN_RANGE = 2; // ±2 bins for re-deposit

// Ledger path
const LEDGER_PATH = join(homedir(), ".hodlmm-fee-harvester.json");

// ─── Output ──────────────────────────────────────────────────────────────
function output(status: string, action: string, data: any, error: any = null) {
  console.log(JSON.stringify({ status, action, data, error }));
}

function log(...args: any[]) {
  console.error("[fee-harvester]", ...args);
}

// ─── Ledger ──────────────────────────────────────────────────────────────
interface BinBaseline {
  binId: number;
  depositX: string; // original x reserve at deposit time (user share)
  depositY: string; // original y reserve at deposit time (user share)
  shares: string;
  recordedAt: string;
}

interface PoolRecord {
  poolId: string;
  bins: Record<number, BinBaseline>;
}

interface HarvestRecord {
  poolId: string;
  timestamp: string;
  binsHarvested: number;
  feesX: string;
  feesY: string;
  gasEstimate: number;
  redeposited: boolean;
}

interface Ledger {
  positions: Record<string, PoolRecord>; // keyed by poolId
  harvests: HarvestRecord[];
}

function loadLedger(): Ledger {
  try {
    if (existsSync(LEDGER_PATH)) {
      return JSON.parse(readFileSync(LEDGER_PATH, "utf-8"));
    }
  } catch {}
  return { positions: {}, harvests: [] };
}

function saveLedger(ledger: Ledger): void {
  writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2));
}

// ─── HODLMM API ──────────────────────────────────────────────────────────
interface PoolInfo {
  pool_id: string;
  active_bin: number;
  token_x: string;
  token_y: string;
  bin_step: number;
}

interface BinData {
  bin_id: number;
  reserve_x: string;
  reserve_y: string;
  userLiquidity?: number;
}

interface BinsResponse {
  active_bin_id: number;
  bins: BinData[];
}

async function fetchJson(url: string): Promise<any> {
  const r = await fetch(url);
  if (!r.ok) return null;
  return r.json();
}

async function fetchAllPools(): Promise<PoolInfo[]> {
  const data = await fetchJson(`${HODLMM_API}/pools`);
  return data?.pools || [];
}

async function fetchPoolInfo(poolId: string): Promise<PoolInfo | null> {
  const pools = await fetchAllPools();
  return pools.find((p: any) => p.pool_id === poolId) || null;
}

async function fetchPoolBins(poolId: string): Promise<BinsResponse | null> {
  return fetchJson(`${HODLMM_API}/bins/${poolId}`);
}

async function fetchUserPositions(poolId: string, address: string): Promise<BinsResponse | null> {
  const data = await fetchJson(`${HODLMM_APP_API}/api/app/v1/users/${address}/positions/${poolId}/bins`);
  if (!data?.bins) return null;
  // Normalize: API returns {bin_id, userLiquidity, price} — map to BinData
  const bins = data.bins.map((b: any) => ({
    bin_id: parseInt(b.bin_id),
    reserve_x: String(Math.floor(b.userLiquidity || 0)),
    reserve_y: "0",
    userLiquidity: b.userLiquidity || 0,
  }));
  return { active_bin_id: 0, bins };
}

async function fetchPoolAppStats(poolId: string): Promise<any> {
  const data = await fetchJson(`${HODLMM_APP_API}/api/app/v1/pools`);
  if (!data) return null;
  const pools = data.data || data.pools || [];
  return pools.find((p: any) => p.pool_id === poolId || p.poolId === poolId) || null;
}

async function fetchStxBalance(address: string): Promise<number> {
  const data = await fetchJson(`${HIRO_API}/extended/v1/address/${address}/stx`);
  return data ? parseInt(data.balance || "0") / 1e6 : 0;
}

async function fetchGasRate(): Promise<number> {
  const data = await fetchJson(`${HIRO_API}/v2/fees/transfer`);
  return data || 200; // uSTX/byte, fallback 200
}

// ─── On-chain reads via Hiro ─────────────────────────────────────────────
async function fetchBinBalancesOnChain(
  poolContract: string,
  binId: number
): Promise<{ binShares: bigint; xBalance: bigint; yBalance: bigint } | null> {
  const [contractAddr, contractName] = poolContract.split(".");
  const url = `${HIRO_API}/v2/contracts/call-read/${contractAddr}/${contractName}`;

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sender: contractAddr,
        function_name: "get-bin-balances",
        arguments: [`0x0100000000000000${binId.toString(16).padStart(16, "0")}`],
      }),
    });
    const data = await resp.json() as any;
    if (!data.okay || !data.result) return null;

    // Parse Clarity tuple response
    const hex = data.result;
    // Simplified: use API position data instead for reliability
    return null;
  } catch {
    return null;
  }
}

// ─── Fee Estimation ──────────────────────────────────────────────────────
interface BinFeeEstimate {
  binId: number;
  currentX: string;
  currentY: string;
  baselineX: string;
  baselineY: string;
  feeX: number; // current - baseline
  feeY: number;
  hasBaseline: boolean;
}

function estimateBinFees(
  currentBins: BinData[],
  baselines: Record<number, BinBaseline>
): BinFeeEstimate[] {
  return currentBins.map((bin) => {
    const baseline = baselines[bin.bin_id];
    const currentX = parseInt(bin.reserve_x || "0");
    const currentY = parseInt(bin.reserve_y || "0");

    if (!baseline) {
      return {
        binId: bin.bin_id,
        currentX: bin.reserve_x,
        currentY: bin.reserve_y,
        baselineX: "0",
        baselineY: "0",
        feeX: 0,
        feeY: 0,
        hasBaseline: false,
      };
    }

    const baseX = parseInt(baseline.depositX || "0");
    const baseY = parseInt(baseline.depositY || "0");

    return {
      binId: bin.bin_id,
      currentX: bin.reserve_x,
      currentY: bin.reserve_y,
      baselineX: baseline.depositX,
      baselineY: baseline.depositY,
      feeX: Math.max(0, currentX - baseX),
      feeY: Math.max(0, currentY - baseY),
      hasBaseline: true,
    };
  });
}

function recordBaselines(
  ledger: Ledger,
  poolId: string,
  bins: BinData[]
): number {
  if (!ledger.positions[poolId]) {
    ledger.positions[poolId] = { poolId, bins: {} };
  }

  let newCount = 0;
  for (const bin of bins) {
    if (!ledger.positions[poolId].bins[bin.bin_id]) {
      ledger.positions[poolId].bins[bin.bin_id] = {
        binId: bin.bin_id,
        depositX: bin.reserve_x,
        depositY: bin.reserve_y,
        shares: "0",
        recordedAt: new Date().toISOString(),
      };
      newCount++;
    }
  }

  return newCount;
}

// ─── CLI ─────────────────────────────────────────────────────────────────
const program = new Command();

program
  .name("hodlmm-fee-harvester")
  .description("Estimate and harvest auto-compounded fees from HODLMM LP positions");

// doctor
program
  .command("doctor")
  .description("Check environment: wallet, HODLMM API, positions")
  .action(async () => {
    const stxAddress = process.env.STX_ADDRESS || "";
    const checks: any = {
      hodlmmApi: false,
      pools: [],
      stxBalance: 0,
      positions: [],
      ledgerExists: existsSync(LEDGER_PATH),
      safetyLimits: {
        minHarvestMultiplier: MIN_HARVEST_MULTIPLIER,
        maxGasSTX: MAX_GAS_STX,
        minPositionSats: MIN_POSITION_SATS,
        slippagePct: HODLMM_SLIPPAGE_PCT,
      },
      mcpRequired: ["bitflow_hodlmm_remove_liquidity", "bitflow_hodlmm_add_liquidity"],
    };

    // Check HODLMM API
    const pools = await fetchAllPools();
    if (pools.length > 0) {
      checks.hodlmmApi = true;
      checks.pools = pools.map((p: any) => ({
        poolId: p.pool_id,
        activeBin: p.active_bin,
        binStep: p.bin_step,
      }));
    }

    if (stxAddress) {
      checks.stxBalance = await fetchStxBalance(stxAddress);

      // Scan positions across known pools
      const poolIds = pools.map((p: any) => p.pool_id);
      const posResults = await Promise.allSettled(
        poolIds.map(async (pid: string) => {
          const pos = await fetchUserPositions(pid, stxAddress);
          if (pos?.bins?.length) {
            return { poolId: pid, bins: pos.bins.length };
          }
          return null;
        })
      );

      checks.positions = posResults
        .filter((r): r is PromiseFulfilledResult<any> => r.status === "fulfilled" && r.value !== null)
        .map((r) => r.value);
    } else {
      checks.note = "Set STX_ADDRESS env var for full diagnostics";
    }

    checks.commands = [
      "doctor",
      "scan",
      "scan --pool dlmm_1",
      "harvest --pool dlmm_1 --confirm",
      "history",
    ];

    output("success", "doctor", checks);
  });

// scan
program
  .command("scan")
  .description("Estimate accrued fees across LP positions (read-only)")
  .option("--pool <id>", "Specific pool to scan (default: all with positions)")
  .action(async (opts) => {
    const stxAddress = process.env.STX_ADDRESS;
    if (!stxAddress) {
      output("blocked", "scan", null, "STX_ADDRESS env var required.");
      return;
    }

    const ledger = loadLedger();
    const gasRate = await fetchGasRate();
    const gasCostSTX = DEFAULT_GAS_ESTIMATE_STX;

    // Determine which pools to scan
    let poolIds: string[];
    if (opts.pool) {
      poolIds = [opts.pool];
    } else {
      const pools = await fetchAllPools();
      poolIds = pools.map((p: any) => p.pool_id);
    }

    log(`Scanning ${poolIds.length} pool(s)...`);

    const results: any[] = [];

    for (const poolId of poolIds) {
      const [poolInfo, userPos, appStats] = await Promise.all([
        fetchPoolInfo(poolId),
        fetchUserPositions(poolId, stxAddress),
        fetchPoolAppStats(poolId),
      ]);

      if (!userPos?.bins?.length) continue;

      // Filter dust positions
      const significantBins = userPos.bins.filter((b) => {
        const xVal = parseInt(b.reserve_x || "0");
        const yVal = parseInt(b.reserve_y || "0");
        return xVal >= MIN_POSITION_SATS || yVal >= MIN_POSITION_SATS;
      });

      if (significantBins.length === 0) continue;

      // Record baselines for new bins
      const newBaselines = recordBaselines(ledger, poolId, significantBins);

      // Estimate fees
      const baselines = ledger.positions[poolId]?.bins || {};
      const feeEstimates = estimateBinFees(significantBins, baselines);

      const totalFeeX = feeEstimates.reduce((sum, e) => sum + e.feeX, 0);
      const totalFeeY = feeEstimates.reduce((sum, e) => sum + e.feeY, 0);
      const binsWithFees = feeEstimates.filter((e) => e.hasBaseline && (e.feeX > 0 || e.feeY > 0));
      const binsWithoutBaseline = feeEstimates.filter((e) => !e.hasBaseline);

      // Check if active bin is in user's range
      const activeBin = poolInfo?.active_bin || 0;
      const userBinIds = significantBins.map((b) => b.bin_id);
      const inRange = userBinIds.includes(activeBin);

      // Profitability check: fees must exceed MIN_HARVEST_MULTIPLIER * gas
      // Simplified: treat fee sats as value proxy. 1 STX gas ≈ 500 sats at typical rates.
      const harvestGas = gasCostSTX * 2; // withdraw + re-deposit
      const minFeeSatsForHarvest = harvestGas * 500 * MIN_HARVEST_MULTIPLIER;
      const totalFeeSats = totalFeeX + totalFeeY;
      const profitable = totalFeeSats >= minFeeSatsForHarvest;

      results.push({
        poolId,
        activeBin,
        inRange,
        totalBins: significantBins.length,
        binsWithFees: binsWithFees.length,
        newBaselinesRecorded: newBaselines,
        binsWithoutBaseline: binsWithoutBaseline.length,
        totalFeeX: String(totalFeeX),
        totalFeeY: String(totalFeeY),
        estimatedHarvestGasSTX: harvestGas,
        minFeeSatsForHarvest,
        totalFeeSats,
        profitable,
        poolStats: appStats
          ? {
              apr24h: appStats.apr24h,
              feesUsd1d: appStats.feesUsd1d,
              feesUsd7d: appStats.feesUsd7d,
              volumeUsd1d: appStats.volumeUsd1d,
              tvlUsd: appStats.tvlUsd,
            }
          : null,
        bins: feeEstimates.map((e) => ({
          binId: e.binId,
          currentX: e.currentX,
          currentY: e.currentY,
          feeX: String(e.feeX),
          feeY: String(e.feeY),
          hasBaseline: e.hasBaseline,
        })),
      });
    }

    // Save updated baselines
    saveLedger(ledger);

    if (results.length === 0) {
      output("success", "scan", {
        positions: [],
        note: "No HODLMM positions found across scanned pools.",
      });
      return;
    }

    output("success", "scan", {
      address: stxAddress,
      poolsScanned: poolIds.length,
      poolsWithPositions: results.length,
      positions: results,
      gasRateUstxPerByte: gasRate,
      note: results.some((r) => r.binsWithoutBaseline > 0)
        ? "Some bins had no baseline — recorded now. Run scan again later to estimate fees."
        : undefined,
    });
  });

// harvest
program
  .command("harvest")
  .description("Harvest accrued fees: withdraw, extract growth, re-deposit principal")
  .requiredOption("--pool <id>", "Pool ID to harvest from")
  .option("--no-redeposit", "Withdraw only, do not re-deposit principal")
  .option("--confirm", "Execute harvest (outputs MCP instructions)", false)
  .action(async (opts) => {
    const stxAddress = process.env.STX_ADDRESS;
    if (!stxAddress) {
      output("blocked", "harvest", null, "STX_ADDRESS env var required.");
      return;
    }

    const poolId = opts.pool;
    const redeposit = opts.redeposit !== false;
    const ledger = loadLedger();

    // Fetch current state
    const [poolInfo, poolBins, userPos] = await Promise.all([
      fetchPoolInfo(poolId),
      fetchPoolBins(poolId),
      fetchUserPositions(poolId, stxAddress),
    ]);

    if (!poolInfo || !poolBins) {
      output("error", "harvest", null, `Could not fetch pool ${poolId}.`);
      return;
    }

    if (!userPos?.bins?.length) {
      output("blocked", "harvest", null, `No positions found in pool ${poolId}.`);
      return;
    }

    const activeBin = poolBins.active_bin_id ?? poolInfo.active_bin;
    const baselines = ledger.positions[poolId]?.bins || {};

    // Estimate fees
    const feeEstimates = estimateBinFees(userPos.bins, baselines);
    const harvestable = feeEstimates.filter((e) => e.hasBaseline && (e.feeX > 0 || e.feeY > 0));

    if (harvestable.length === 0) {
      output("blocked", "harvest", {
        binsScanned: feeEstimates.length,
        binsWithBaseline: feeEstimates.filter((e) => e.hasBaseline).length,
        hint: feeEstimates.some((e) => !e.hasBaseline)
          ? "Some bins have no baseline. Run `scan` first to establish baselines."
          : "No fee growth detected since last baseline.",
      }, "No harvestable fees found.");
      return;
    }

    const totalFeeX = harvestable.reduce((sum, e) => sum + e.feeX, 0);
    const totalFeeY = harvestable.reduce((sum, e) => sum + e.feeY, 0);

    // Gas check
    const gasPerTx = DEFAULT_GAS_ESTIMATE_STX;
    const totalGas = gasPerTx * (redeposit ? 2 : 1); // withdraw + optional re-deposit

    // Profitability gate: fees must exceed MIN_HARVEST_MULTIPLIER * gas
    const minFeeSatsForHarvest = totalGas * 500 * MIN_HARVEST_MULTIPLIER;
    const totalFeeSats = totalFeeX + totalFeeY;
    if (totalFeeSats < minFeeSatsForHarvest) {
      output("blocked", "harvest", {
        totalFeeSats,
        minFeeSatsForHarvest,
        estimatedGasSTX: totalGas,
      }, `Fees (${totalFeeSats} sats) below profitability threshold (${minFeeSatsForHarvest} sats = ${MIN_HARVEST_MULTIPLIER}x gas). Not worth harvesting yet.`);
      return;
    }

    if (totalGas > MAX_GAS_STX) {
      output("blocked", "harvest", null, `Estimated gas ${totalGas} STX exceeds max (${MAX_GAS_STX} STX).`);
      return;
    }

    // Balance check for gas
    const stxBalance = await fetchStxBalance(stxAddress);
    if (stxBalance < totalGas + 1) {
      output("blocked", "harvest", null, `Insufficient STX for gas. Have ${stxBalance}, need ~${totalGas + 1} STX.`);
      return;
    }

    // Build harvest plan
    const withdrawBinIds = harvestable.map((e) => e.binId);
    const principalBins = harvestable.map((e) => ({
      binId: e.binId,
      principalX: e.baselineX,
      principalY: e.baselineY,
      feeX: String(e.feeX),
      feeY: String(e.feeY),
    }));

    // Re-deposit targets: bins centered on active bin
    const redepositBins: { bin_id: number; amount_x: string; amount_y: string }[] = [];
    if (redeposit) {
      const totalPrincipalX = harvestable.reduce((s, e) => s + parseInt(e.baselineX || "0"), 0);
      const totalPrincipalY = harvestable.reduce((s, e) => s + parseInt(e.baselineY || "0"), 0);
      const binCount = DEFAULT_BIN_RANGE * 2 + 1;
      const perBinX = Math.floor(totalPrincipalX / binCount);
      const perBinY = Math.floor(totalPrincipalY / binCount);

      for (let offset = -DEFAULT_BIN_RANGE; offset <= DEFAULT_BIN_RANGE; offset++) {
        // Bins below active: token_y only (quote side)
        // Bins at/above active: token_x only (base side)
        if (offset < 0) {
          redepositBins.push({ bin_id: activeBin + offset, amount_x: "0", amount_y: String(perBinY) });
        } else {
          redepositBins.push({ bin_id: activeBin + offset, amount_x: String(perBinX), amount_y: "0" });
        }
      }
    }

    const harvestPlan = {
      poolId,
      activeBin,
      binsToHarvest: harvestable.length,
      totalFeeX: String(totalFeeX),
      totalFeeY: String(totalFeeY),
      estimatedGasSTX: totalGas,
      redeposit,
      withdrawBinIds,
      principalBins,
      redepositBins: redeposit ? redepositBins : [],
    };

    if (!opts.confirm) {
      output("success", "harvest", {
        ...harvestPlan,
        mode: "dry-run",
        hint: "Add --confirm to generate MCP execution instructions.",
      });
      return;
    }

    // Output MCP instructions
    const mcpSteps: any[] = [];

    // Step 1: Withdraw from all harvestable bins
    mcpSteps.push({
      step: 1,
      description: "Withdraw liquidity from bins with accrued fees",
      tool: "bitflow_hodlmm_remove_liquidity",
      params: {
        poolId,
        binIds: withdrawBinIds,
        slippagePct: HODLMM_SLIPPAGE_PCT,
      },
    });

    // Step 2: Re-deposit principal (if requested)
    if (redeposit && redepositBins.length > 0) {
      mcpSteps.push({
        step: 2,
        description: "Re-deposit principal into bins centered on active bin",
        tool: "bitflow_hodlmm_add_liquidity",
        params: {
          poolId,
          bins: redepositBins,
          slippagePct: HODLMM_SLIPPAGE_PCT,
        },
      });
    }

    // Record harvest in ledger
    ledger.harvests.push({
      poolId,
      timestamp: new Date().toISOString(),
      binsHarvested: harvestable.length,
      feesX: String(totalFeeX),
      feesY: String(totalFeeY),
      gasEstimate: totalGas,
      redeposited: redeposit,
    });

    // Update baselines for re-deposited bins
    if (redeposit) {
      if (!ledger.positions[poolId]) {
        ledger.positions[poolId] = { poolId, bins: {} };
      }
      // Clear old baselines for harvested bins
      for (const binId of withdrawBinIds) {
        delete ledger.positions[poolId].bins[binId];
      }
      // Set new baselines for re-deposit bins
      for (const bin of redepositBins) {
        ledger.positions[poolId].bins[bin.bin_id] = {
          binId: bin.bin_id,
          depositX: bin.amount_x,
          depositY: bin.amount_y,
          shares: "0",
          recordedAt: new Date().toISOString(),
        };
      }
    } else {
      // If no re-deposit, clear all harvested baselines
      for (const binId of withdrawBinIds) {
        delete ledger.positions[poolId]?.bins?.[binId];
      }
    }

    saveLedger(ledger);

    output("success", "harvest", {
      ...harvestPlan,
      mode: "execute",
      mcpInstructions: mcpSteps,
      note: "Execute MCP steps in order. Step 1 must complete before Step 2.",
    });
  });

// history
program
  .command("history")
  .description("Show harvest history from local ledger")
  .action(async () => {
    const ledger = loadLedger();

    if (ledger.harvests.length === 0) {
      output("success", "history", {
        harvests: [],
        note: "No harvests recorded yet.",
      });
      return;
    }

    const totalFeesX = ledger.harvests.reduce((s, h) => s + parseInt(h.feesX || "0"), 0);
    const totalFeesY = ledger.harvests.reduce((s, h) => s + parseInt(h.feesY || "0"), 0);
    const totalGas = ledger.harvests.reduce((s, h) => s + h.gasEstimate, 0);

    output("success", "history", {
      totalHarvests: ledger.harvests.length,
      cumulativeFeesX: String(totalFeesX),
      cumulativeFeesY: String(totalFeesY),
      cumulativeGasSTX: totalGas,
      trackedPools: Object.keys(ledger.positions).length,
      trackedBins: Object.values(ledger.positions).reduce(
        (s, p) => s + Object.keys(p.bins).length,
        0
      ),
      harvests: ledger.harvests.slice(-20), // last 20
    });
  });

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
