#!/usr/bin/env bun
/**
 * bitflow-smart-dca-v2 — Market-Aware DCA + HODLMM LP Deployment
 *
 * v2 changes from v1:
 *   - Commander.js CLI (per SKILL_TEMPLATE §3)
 *   - Persistent daily spend tracking (~/.bitflow-smart-dca-spend.json)
 *   - HODLMM LP deployment: route DCA output into HODLMM bins
 *   - Fixed frontmatter and AGENT.md format
 */

import { Command } from "commander";
import { BitflowSDK, KeeperType } from "@bitflowlabs/core-sdk";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// ─── Config ───────────────────────────────────────────────────────────────
const BITFLOW_CONFIG = {
  BITFLOW_API_HOST: "https://bitflowsdk-api-test-7owjsmt8.uk.gateway.dev",
  READONLY_CALL_API_HOST: "https://api.hiro.so",
  BITFLOW_PROVIDER_ADDRESS: "",
  READONLY_CALL_API_KEY: "",
  KEEPER_API_HOST: "https://bitflow-keeper-test-7owjsmt8.uc.gateway.dev",
};

const MEMPOOL_API = "https://mempool.space/api";
const HIRO_API = "https://api.hiro.so";
const HODLMM_API = "https://bff.bitflowapis.finance/api/quotes/v1";
const HODLMM_APP_API = "https://bff.bitflowapis.finance";

// Safety limits
const MAX_SINGLE_ORDER_STX = 500;
const MAX_DAILY_SPEND_STX = 1000;
const MAX_SLIPPAGE_PCT = 5;
const MIN_BALANCE_RESERVE_STX = 1;
const SUPPORTED_TARGETS = ["token-sbtc", "token-stx", "token-welsh", "token-alex"];

// HODLMM limits
const MAX_DEPLOY_SATS = 500_000;
const HODLMM_SLIPPAGE_PCT = 0.5;
const DEFAULT_BIN_RANGE = 2; // ±2 bins around active = 5 total
const DEFAULT_POOL = "dlmm_1";

// Spend ledger path
const SPEND_LEDGER_PATH = join(homedir(), ".bitflow-smart-dca-spend.json");

// ─── Output ──────────────────────────────────────────────────────────────
function output(status: string, action: string, data: any, error: any = null) {
  console.log(JSON.stringify({ status, action, data, error }));
}

function log(...args: any[]) {
  console.error("[smart-dca-v2]", ...args);
}

// ─── Spend Ledger ────────────────────────────────────────────────────────
interface SpendLedger {
  date: string; // YYYY-MM-DD UTC
  totalSpentSTX: number;
  orders: { amount: number; timestamp: string; orderId?: string }[];
}

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

function loadLedger(): SpendLedger {
  try {
    if (existsSync(SPEND_LEDGER_PATH)) {
      const raw = readFileSync(SPEND_LEDGER_PATH, "utf-8");
      const ledger = JSON.parse(raw) as SpendLedger;
      if (ledger.date === todayUTC()) return ledger;
    }
  } catch {}
  return { date: todayUTC(), totalSpentSTX: 0, orders: [] };
}

function saveLedger(ledger: SpendLedger): void {
  writeFileSync(SPEND_LEDGER_PATH, JSON.stringify(ledger, null, 2));
}

function recordSpend(amount: number, orderId?: string): void {
  const ledger = loadLedger();
  ledger.totalSpentSTX += amount;
  ledger.orders.push({ amount, timestamp: new Date().toISOString(), orderId });
  saveLedger(ledger);
}

function remainingDailyBudget(): number {
  const ledger = loadLedger();
  return Math.max(0, MAX_DAILY_SPEND_STX - ledger.totalSpentSTX);
}

// ─── Market Analysis ─────────────────────────────────────────────────────
interface MarketConditions {
  btcFeeRate: number;
  btcMempoolSize: number;
  btcMempoolTxCount: number;
  hashrate: number | null;
  difficultyAdjustment: { changePct: number; blocksRemaining: number } | null;
  stxBalance: number;
  sbtcBalance: number;
  timestamp: string;
}

async function fetchMarketConditions(stxAddress: string): Promise<MarketConditions> {
  const results: MarketConditions = {
    btcFeeRate: 0,
    btcMempoolSize: 0,
    btcMempoolTxCount: 0,
    hashrate: null,
    difficultyAdjustment: null,
    stxBalance: 0,
    sbtcBalance: 0,
    timestamp: new Date().toISOString(),
  };

  const fetches = await Promise.allSettled([
    fetch(`${MEMPOOL_API}/v1/fees/recommended`).then(r => r.json()),
    fetch(`${MEMPOOL_API}/mempool`).then(r => r.json()),
    fetch(`${MEMPOOL_API}/v1/mining/hashrate/1w`).then(r => r.json()),
    fetch(`${MEMPOOL_API}/v1/difficulty-adjustment`).then(r => r.json()),
    fetch(`${HIRO_API}/extended/v1/address/${stxAddress}/balances`).then(r => r.json()),
  ]);

  if (fetches[0].status === "fulfilled") {
    results.btcFeeRate = (fetches[0].value as any).fastestFee || 1;
  }
  if (fetches[1].status === "fulfilled") {
    const d = fetches[1].value as any;
    results.btcMempoolSize = d.vsize || 0;
    results.btcMempoolTxCount = d.count || 0;
  }
  if (fetches[2].status === "fulfilled") {
    const d = fetches[2].value as any;
    results.hashrate = d.currentHashrate ? d.currentHashrate / 1e18 : null;
  }
  if (fetches[3].status === "fulfilled") {
    const d = fetches[3].value as any;
    results.difficultyAdjustment = {
      changePct: Math.round((d.difficultyChange || 0) * 100) / 100,
      blocksRemaining: d.remainingBlocks || 0,
    };
  }
  if (fetches[4].status === "fulfilled") {
    const d = fetches[4].value as any;
    results.stxBalance = parseInt(d.stx?.balance || "0") / 1e6;
    const SBTC_CONTRACT = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token::sbtc-token";
    if (d.fungible_tokens?.[SBTC_CONTRACT]) {
      results.sbtcBalance = parseInt(d.fungible_tokens[SBTC_CONTRACT].balance || "0");
    }
  }

  return results;
}

interface DCASignal {
  recommendation: "buy" | "wait" | "reduce";
  confidence: "high" | "medium" | "low";
  reasons: string[];
  suggestedAmountPct: number;
  riskFactors: string[];
}

function analyzeDCASignal(market: MarketConditions): DCASignal {
  const reasons: string[] = [];
  const riskFactors: string[] = [];
  let score = 0;

  if (market.btcFeeRate <= 2) {
    score += 2;
    reasons.push(`BTC fees at ${market.btcFeeRate} sat/vB — historically low, cheap execution`);
  } else if (market.btcFeeRate <= 5) {
    score += 1;
    reasons.push(`BTC fees at ${market.btcFeeRate} sat/vB — moderate`);
  } else if (market.btcFeeRate > 20) {
    score -= 1;
    riskFactors.push(`BTC fees elevated at ${market.btcFeeRate} sat/vB`);
  }

  if (market.btcMempoolTxCount < 10000) {
    score += 1;
    reasons.push(`Mempool clear (${market.btcMempoolTxCount} txs)`);
  } else if (market.btcMempoolTxCount > 50000) {
    score -= 1;
    riskFactors.push(`Mempool congested (${market.btcMempoolTxCount} txs)`);
  }

  if (market.hashrate && market.hashrate > 900) {
    score += 1;
    reasons.push(`Hashrate strong at ${market.hashrate.toFixed(0)} EH/s`);
  }

  if (market.difficultyAdjustment) {
    if (market.difficultyAdjustment.changePct > 2) {
      score += 1;
      reasons.push(`Difficulty +${market.difficultyAdjustment.changePct.toFixed(1)}% incoming — miner confidence`);
    } else if (market.difficultyAdjustment.changePct < -5) {
      riskFactors.push(`Difficulty ${market.difficultyAdjustment.changePct.toFixed(1)}% — miners leaving`);
    }
  }

  let recommendation: "buy" | "wait" | "reduce";
  let confidence: "high" | "medium" | "low";
  let suggestedAmountPct: number;

  if (score >= 3) {
    recommendation = "buy";
    confidence = "high";
    suggestedAmountPct = 100;
  } else if (score >= 1) {
    recommendation = "buy";
    confidence = "medium";
    suggestedAmountPct = 75;
  } else if (score >= 0) {
    recommendation = "wait";
    confidence = "low";
    suggestedAmountPct = 50;
  } else {
    recommendation = "reduce";
    confidence = "medium";
    suggestedAmountPct = 25;
    riskFactors.push("Multiple negative signals — consider reducing position size");
  }

  return { recommendation, confidence, reasons, suggestedAmountPct, riskFactors };
}

// ─── HODLMM ──────────────────────────────────────────────────────────────
interface HodlmmPoolInfo {
  pool_id: string;
  active_bin: number;
  token_x: string;
  token_y: string;
  bin_step: number;
}

interface HodlmmBin {
  bin_id: number;
  reserve_x: string;
  reserve_y: string;
}

async function fetchPoolInfo(poolId: string): Promise<HodlmmPoolInfo | null> {
  try {
    const r = await fetch(`${HODLMM_API}/pools`);
    if (!r.ok) return null;
    const d = await r.json() as any;
    const pools = d.pools || [];
    return pools.find((p: any) => p.pool_id === poolId) || null;
  } catch {
    return null;
  }
}

async function fetchPoolBins(poolId: string): Promise<{ active_bin_id: number; bins: HodlmmBin[] } | null> {
  try {
    const r = await fetch(`${HODLMM_API}/bins/${poolId}`);
    if (!r.ok) return null;
    return await r.json() as any;
  } catch {
    return null;
  }
}

async function fetchUserPositions(poolId: string, address: string): Promise<{ bins: HodlmmBin[] } | null> {
  try {
    const r = await fetch(`${HODLMM_APP_API}/api/app/v1/users/${address}/positions/${poolId}/bins`);
    if (!r.ok) return null;
    return await r.json() as any;
  } catch {
    return null;
  }
}

async function fetchPoolStats(poolId: string): Promise<any> {
  try {
    const r = await fetch(`${HODLMM_APP_API}/api/app/v1/pools`);
    if (!r.ok) return null;
    const d = await r.json() as any;
    const pools = d.data || d.pools || [];
    return pools.find((p: any) => p.pool_id === poolId || p.poolId === poolId) || null;
  } catch {
    return null;
  }
}

function buildDeployBins(activeBin: number, totalSats: number, range: number): { bin_id: number; amount_x: string; amount_y: string }[] {
  const bins: { bin_id: number; amount_x: string; amount_y: string }[] = [];
  const binCount = range * 2 + 1;
  const perBinSats = Math.floor(totalSats / binCount);

  for (let offset = -range; offset <= range; offset++) {
    const binId = activeBin + offset;
    // Bins below active: token_y only (quote side)
    // Bins at/above active: token_x only (base side, sBTC)
    if (offset < 0) {
      bins.push({ bin_id: binId, amount_x: "0", amount_y: String(perBinSats) });
    } else {
      bins.push({ bin_id: binId, amount_x: String(perBinSats), amount_y: "0" });
    }
  }

  return bins;
}

// ─── Token Utils ─────────────────────────────────────────────────────────
function resolveTokenId(input: string): string {
  const aliases: Record<string, string> = {
    stx: "token-stx", STX: "token-stx",
    sbtc: "token-sbtc", sBTC: "token-sbtc",
    welsh: "token-welsh", WELSH: "token-welsh",
    alex: "token-alex", ALEX: "token-alex",
  };
  return aliases[input] || input;
}

// ─── CLI (Commander.js) ──────────────────────────────────────────────────
const program = new Command();

program
  .name("bitflow-smart-dca-v2")
  .description("Market-aware DCA into sBTC via Bitflow Keeper with HODLMM LP deployment");

// doctor
program
  .command("doctor")
  .description("Check environment readiness: wallet, APIs, balances, HODLMM pools")
  .action(async () => {
    const checks: any = {
      bitflowApi: false,
      keeperApi: false,
      hodlmmApi: false,
      tokenCount: 0,
      stxBalance: 0,
      sbtcBalance: 0,
      dailyBudgetRemaining: remainingDailyBudget(),
      keeperContract: null,
      safetyLimits: {
        maxSingleOrderSTX: MAX_SINGLE_ORDER_STX,
        maxDailySpendSTX: MAX_DAILY_SPEND_STX,
        maxSlippagePct: MAX_SLIPPAGE_PCT,
        minBalanceReserveSTX: MIN_BALANCE_RESERVE_STX,
        maxDeploySats: MAX_DEPLOY_SATS,
        hodlmmSlippagePct: HODLMM_SLIPPAGE_PCT,
      },
    };

    const bitflow = new BitflowSDK(BITFLOW_CONFIG);

    // Check Bitflow API
    try {
      const tokens = await bitflow.getAvailableTokens();
      checks.bitflowApi = true;
      checks.tokenCount = tokens.length;
    } catch (e: any) {
      checks.bitflowApiError = e.message;
    }

    // Check HODLMM API
    const poolInfo = await fetchPoolInfo(DEFAULT_POOL);
    if (poolInfo) {
      checks.hodlmmApi = true;
      checks.hodlmmDefaultPool = {
        poolId: poolInfo.pool_id,
        activeBin: poolInfo.active_bin,
        binStep: poolInfo.bin_step,
      };
    } else {
      checks.hodlmmApiError = "Could not reach HODLMM pool API";
    }

    // Check balances
    const stxAddress = process.env.STX_ADDRESS || "";
    if (stxAddress) {
      const market = await fetchMarketConditions(stxAddress);
      checks.stxBalance = market.stxBalance;
      checks.sbtcBalance = market.sbtcBalance;
      checks.availableForDCA = Math.max(0, market.stxBalance - MIN_BALANCE_RESERVE_STX);

      // Check Keeper contract
      try {
        const keeper = await bitflow.getOrCreateKeeperContract({
          stacksAddress: stxAddress,
          keeperType: KeeperType.MULTI_ACTION_V1,
        });
        checks.keeperApi = true;
        checks.keeperContract = keeper?.keeperContract?.contractIdentifier || "available";
      } catch (e: any) {
        checks.keeperApiError = e.message;
      }

      // Check HODLMM position
      if (poolInfo) {
        const pos = await fetchUserPositions(DEFAULT_POOL, stxAddress);
        checks.hodlmmPosition = pos?.bins?.length
          ? { bins: pos.bins.length, poolId: DEFAULT_POOL }
          : { bins: 0, note: "No existing HODLMM position" };
      }
    } else {
      checks.note = "Set STX_ADDRESS env var for full diagnostics";
    }

    checks.supportedTargets = SUPPORTED_TARGETS;
    checks.commands = ["doctor", "analyze", "run --amount 10 --to sBTC", "deploy --pool dlmm_1 --amount 50000", "status", "cancel --order-id <id>"];
    checks.mcpRequired = ["bitflow_hodlmm_add_liquidity"];

    output("success", "doctor", checks);
  });

// analyze
program
  .command("analyze")
  .description("Assess market conditions for DCA timing (read-only)")
  .action(async () => {
    const stxAddress = process.env.STX_ADDRESS || "";
    if (!stxAddress) {
      output("blocked", "analyze", null, "STX_ADDRESS env var required.");
      return;
    }

    log("Fetching market data...");
    const market = await fetchMarketConditions(stxAddress);
    const signal = analyzeDCASignal(market);

    output("success", "analyze", {
      market,
      signal,
      availableForDCA: Math.max(0, market.stxBalance - MIN_BALANCE_RESERVE_STX),
      dailyBudgetRemaining: remainingDailyBudget(),
      note: signal.recommendation === "buy"
        ? `Conditions favor DCA. Suggested: ${signal.suggestedAmountPct}% of normal amount.`
        : signal.recommendation === "wait"
        ? "Mixed signals. Consider smaller position or waiting."
        : "Unfavorable conditions. Reduce exposure or skip this cycle.",
    });
  });

// run
program
  .command("run")
  .description("Create a DCA order via Bitflow Keeper")
  .requiredOption("--amount <stx>", "Amount in STX to spend")
  .option("--from <token>", "Source token", "STX")
  .option("--to <token>", "Target token", "sBTC")
  .option("--force", "Override market analysis warning", false)
  .action(async (opts) => {
    const stxAddress = process.env.STX_ADDRESS;
    if (!stxAddress) {
      output("blocked", "run", null, "STX_ADDRESS env var required.");
      return;
    }

    const amount = parseFloat(opts.amount);
    if (isNaN(amount) || amount <= 0) {
      output("error", "run", null, `Invalid amount: ${opts.amount}`);
      return;
    }

    const resolvedFrom = resolveTokenId(opts.from);
    const resolvedTo = resolveTokenId(opts.to);

    // Safety: single order limit
    if (amount > MAX_SINGLE_ORDER_STX) {
      output("blocked", "run", null, `Amount ${amount} STX exceeds max single order (${MAX_SINGLE_ORDER_STX} STX).`);
      return;
    }

    // Safety: daily spend limit (persistent)
    const remaining = remainingDailyBudget();
    if (amount > remaining) {
      output("blocked", "run", {
        dailySpent: MAX_DAILY_SPEND_STX - remaining,
        dailyLimit: MAX_DAILY_SPEND_STX,
        remaining,
      }, `Amount ${amount} STX exceeds remaining daily budget (${remaining} STX of ${MAX_DAILY_SPEND_STX} STX).`);
      return;
    }

    // Safety: balance check
    const market = await fetchMarketConditions(stxAddress);
    const available = market.stxBalance - MIN_BALANCE_RESERVE_STX;
    if (amount > available) {
      output("blocked", "run", null, `Insufficient balance. Have ${market.stxBalance} STX, need ${amount} + ${MIN_BALANCE_RESERVE_STX} reserve.`);
      return;
    }

    // Safety: token validation
    if (!SUPPORTED_TARGETS.includes(resolvedTo) && !SUPPORTED_TARGETS.includes(resolvedFrom)) {
      output("blocked", "run", null, `Unsupported token pair. Supported: ${SUPPORTED_TARGETS.join(", ")}`);
      return;
    }

    // Safety: market analysis
    if (!opts.force) {
      const signal = analyzeDCASignal(market);
      if (signal.recommendation === "reduce") {
        output("blocked", "run", {
          signal,
          hint: "Use --force to override market analysis warning",
        }, `Market conditions unfavorable (${signal.riskFactors.join("; ")}). Use --force to override.`);
        return;
      }
    }

    // Get quote + check slippage
    log("Getting quote...");
    const bitflow = new BitflowSDK(BITFLOW_CONFIG);
    await bitflow.getAvailableTokens();

    let quote: any;
    try {
      quote = await bitflow.getQuoteForRoute(resolvedFrom, resolvedTo, amount);
    } catch (e: any) {
      output("error", "run", null, `No route found: ${e.message}`);
      return;
    }

    if (!quote?.bestRoute?.quote) {
      output("error", "run", null, "No valid quote returned from Bitflow.");
      return;
    }

    const expectedOut = quote.bestRoute.quote;
    const minReceived = Math.floor(expectedOut * (1 - MAX_SLIPPAGE_PCT / 100));

    // Execute via Keeper
    log("Creating Keeper DCA order...");
    try {
      const keeper = await bitflow.getOrCreateKeeperContract({
        stacksAddress: stxAddress,
        keeperType: KeeperType.MULTI_ACTION_V1,
      });
      const contractId = keeper.keeperContract.contractIdentifier;

      // STX = 6 decimals, sBTC = 8 decimals
      const KNOWN_DECIMALS: Record<string, number> = { "token-stx": 6, "token-sbtc": 8, "token-welsh": 6, "token-alex": 8 };
      const tokenXDecimals = quote.bestRoute.tokenXDecimals ?? KNOWN_DECIMALS[resolvedFrom] ?? 6;
      const baseAmount = Math.round(amount * 10 ** tokenXDecimals);

      const order = await bitflow.createOrder({
        contractIdentifier: contractId,
        stacksAddress: stxAddress,
        keeperType: KeeperType.MULTI_ACTION_V1,
        actionType: "SWAP_XYK_SWAP_HELPER",
        fundingTokens: { [resolvedFrom]: String(baseAmount) },
        actionAmount: String(baseAmount),
        minReceived: String(minReceived),
        bitcoinTxId: "",
      });

      const orderId = order.keeperOrder.orderId;

      // Record spend in persistent ledger
      recordSpend(amount, orderId);

      output("success", "run", {
        orderId,
        status: order.keeperOrder.orderStatus,
        from: resolvedFrom,
        to: resolvedTo,
        amountIn: amount,
        expectedOut,
        minReceived,
        maxSlippagePct: MAX_SLIPPAGE_PCT,
        keeperContract: contractId,
        marketSignal: opts.force ? "overridden" : analyzeDCASignal(market).recommendation,
        dailyBudgetRemaining: remainingDailyBudget(),
        safetyChecks: {
          balanceCheck: "passed",
          singleOrderLimit: "passed",
          dailySpendLimit: "passed",
          slippageGuard: `${MAX_SLIPPAGE_PCT}% max`,
        },
        nextStep: "Run `deploy` after sBTC arrives to route into HODLMM LP",
      });
    } catch (e: any) {
      output("error", "run", null, `Keeper order failed: ${e.message}`);
    }
  });

// deploy
program
  .command("deploy")
  .description("Deploy sBTC into HODLMM LP position")
  .option("--pool <id>", "HODLMM pool ID", DEFAULT_POOL)
  .option("--amount <sats>", "Amount in sats to deploy", "0")
  .option("--range <bins>", "Bin range ± around active bin", String(DEFAULT_BIN_RANGE))
  .option("--confirm", "Confirm execution (outputs MCP instructions)", false)
  .action(async (opts) => {
    const stxAddress = process.env.STX_ADDRESS;
    if (!stxAddress) {
      output("blocked", "deploy", null, "STX_ADDRESS env var required.");
      return;
    }

    const amountSats = parseInt(opts.amount);
    const range = parseInt(opts.range);

    if (amountSats <= 0) {
      output("blocked", "deploy", null, "Missing --amount <sats>. Usage: deploy --pool dlmm_1 --amount 50000");
      return;
    }

    // Safety: max deploy limit
    if (amountSats > MAX_DEPLOY_SATS) {
      output("blocked", "deploy", null, `Amount ${amountSats} sats exceeds max deploy limit (${MAX_DEPLOY_SATS} sats).`);
      return;
    }

    // Check sBTC balance
    const market = await fetchMarketConditions(stxAddress);
    if (market.sbtcBalance < amountSats) {
      output("blocked", "deploy", {
        sbtcBalance: market.sbtcBalance,
        requested: amountSats,
      }, `Insufficient sBTC. Have ${market.sbtcBalance} sats, need ${amountSats}.`);
      return;
    }

    // Fetch pool state
    log("Fetching HODLMM pool state...");
    const [poolInfo, poolBins, poolStats, existingPos] = await Promise.all([
      fetchPoolInfo(opts.pool),
      fetchPoolBins(opts.pool),
      fetchPoolStats(opts.pool),
      fetchUserPositions(opts.pool, stxAddress),
    ]);

    if (!poolInfo || !poolBins) {
      output("error", "deploy", null, `Could not fetch pool ${opts.pool}. Check pool ID.`);
      return;
    }

    const activeBin = poolBins.active_bin_id ?? poolInfo.active_bin;

    // Safety: check pool has volume (basic sanity)
    if (poolStats?.volumeUsd1d !== undefined && parseFloat(poolStats.volumeUsd1d) < 1000) {
      output("blocked", "deploy", {
        poolId: opts.pool,
        volume24h: poolStats.volumeUsd1d,
      }, `Pool 24h volume too low ($${poolStats.volumeUsd1d}). Risk of impermanent loss without fee income.`);
      return;
    }

    // Build target bins
    const targetBins = buildDeployBins(activeBin, amountSats, range);

    const deployPlan = {
      poolId: opts.pool,
      activeBin,
      binStep: poolInfo.bin_step,
      amountSats,
      binRange: `${activeBin - range} to ${activeBin + range} (${targetBins.length} bins)`,
      satsPerBin: Math.floor(amountSats / targetBins.length),
      existingPosition: existingPos?.bins?.length
        ? { bins: existingPos.bins.length }
        : null,
      poolStats: poolStats
        ? { tvlUsd: poolStats.tvlUsd, volumeUsd1d: poolStats.volumeUsd1d, apr24h: poolStats.apr24h }
        : null,
    };

    if (!opts.confirm) {
      output("success", "deploy", {
        ...deployPlan,
        mode: "dry-run",
        hint: "Add --confirm to generate MCP execution instructions",
      });
      return;
    }

    // Output MCP instructions for agent framework
    output("success", "deploy", {
      ...deployPlan,
      mode: "execute",
      mcpInstructions: {
        tool: "bitflow_hodlmm_add_liquidity",
        params: {
          poolId: opts.pool,
          bins: targetBins,
          slippagePct: HODLMM_SLIPPAGE_PCT,
        },
        note: "Execute this MCP tool call to deposit into HODLMM. The agent framework handles the on-chain transaction.",
      },
    });
  });

// status
program
  .command("status")
  .description("Check Keeper orders and HODLMM LP positions")
  .action(async () => {
    const stxAddress = process.env.STX_ADDRESS;
    if (!stxAddress) {
      output("blocked", "status", null, "STX_ADDRESS env var required.");
      return;
    }

    const bitflow = new BitflowSDK(BITFLOW_CONFIG);

    try {
      const user = await bitflow.getUser(stxAddress);
      const contracts = Object.values(user.user.keeperContracts || {}).map((c: any) => ({
        identifier: c.contractIdentifier,
        status: c.contractStatus,
      }));
      const orders = Object.values(user.user.keeperOrders || {}).map((o: any) => ({
        orderId: o.orderId,
        status: o.orderStatus,
        actionType: o.actionType,
        actionAmount: o.actionAmount,
        createdAt: o.createdAt,
      }));

      // HODLMM position
      let hodlmmPosition: any = null;
      const poolInfo = await fetchPoolInfo(DEFAULT_POOL);
      if (poolInfo) {
        const pos = await fetchUserPositions(DEFAULT_POOL, stxAddress);
        if (pos?.bins?.length) {
          hodlmmPosition = {
            poolId: DEFAULT_POOL,
            activeBin: poolInfo.active_bin,
            userBins: pos.bins.length,
            bins: pos.bins.map(b => ({
              binId: b.bin_id,
              reserveX: b.reserve_x,
              reserveY: b.reserve_y,
            })),
          };
        }
      }

      output("success", "status", {
        address: stxAddress,
        contracts,
        orders,
        activeOrders: orders.filter((o: any) => o.status === "PENDING").length,
        totalOrders: orders.length,
        dailySpend: loadLedger(),
        hodlmmPosition,
      });
    } catch (e: any) {
      output("error", "status", null, `Failed to fetch status: ${e.message}`);
    }
  });

// cancel
program
  .command("cancel")
  .description("Cancel a pending Keeper order")
  .requiredOption("--order-id <id>", "Order ID to cancel")
  .action(async (opts) => {
    const bitflow = new BitflowSDK(BITFLOW_CONFIG);
    try {
      const result = await bitflow.cancelOrder(opts.orderId);
      output("success", "cancel", { orderId: opts.orderId, status: "cancelled", result });
    } catch (e: any) {
      output("error", "cancel", null, `Cancel failed: ${e.message}`);
    }
  });

program.parse();
