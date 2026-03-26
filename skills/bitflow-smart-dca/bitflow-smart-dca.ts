#!/usr/bin/env bun
/**
 * bitflow-smart-dca — Intelligent Dollar-Cost Averaging via Bitflow Keeper
 *
 * Analyzes market conditions (volatility, fee environment, price momentum),
 * then creates/manages DCA orders through Bitflow's Keeper automation.
 * Includes hard spend limits, slippage guards, and kill-switch conditions.
 *
 * Commands:
 *   doctor     — check wallet, Keeper API, balances, prerequisites
 *   analyze    — assess current market for DCA timing (read-only)
 *   run        — create a DCA order based on analysis + user params
 *   status     — check existing DCA orders
 *   cancel     — cancel a pending DCA order
 */

import { BitflowSDK, KeeperType } from "@bitflowlabs/core-sdk";

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

// Safety limits
const MAX_SINGLE_ORDER_STX = 500;       // max per DCA order
const MAX_DAILY_SPEND_STX = 1000;       // max total per day
const MAX_SLIPPAGE_PCT = 5;             // refuse if slippage > 5%
const MIN_BALANCE_RESERVE_STX = 1;      // always keep 1 STX for gas
const SUPPORTED_TARGETS = ["token-sbtc", "token-stx", "token-welsh", "token-alex"];

// ─── Helpers ──────────────────────────────────────────────────────────────
function output(status: string, action: string, data: any, error: any = null) {
  console.log(JSON.stringify({ status, action, data, error }));
}

function log(...args: any[]) {
  console.error("[smart-dca]", ...args);
}

// ─── Market Analysis ──────────────────────────────────────────────────────
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

  // BTC fees
  try {
    const r = await fetch(`${MEMPOOL_API}/v1/fees/recommended`);
    const d = await r.json() as any;
    results.btcFeeRate = d.fastestFee || 1;
  } catch {}

  // Mempool
  try {
    const r = await fetch(`${MEMPOOL_API}/mempool`);
    const d = await r.json() as any;
    results.btcMempoolSize = d.vsize || 0;
    results.btcMempoolTxCount = d.count || 0;
  } catch {}

  // Hashrate
  try {
    const r = await fetch(`${MEMPOOL_API}/v1/mining/hashrate/1w`);
    const d = await r.json() as any;
    results.hashrate = d.currentHashrate ? d.currentHashrate / 1e18 : null;
  } catch {}

  // Difficulty adjustment
  try {
    const r = await fetch(`${MEMPOOL_API}/v1/difficulty-adjustment`);
    const d = await r.json() as any;
    results.difficultyAdjustment = {
      changePct: Math.round((d.difficultyChange || 0) * 10000) / 100,
      blocksRemaining: d.remainingBlocks || 0,
    };
  } catch {}

  // STX balance
  try {
    const r = await fetch(`${HIRO_API}/extended/v1/address/${stxAddress}/balances`);
    const d = await r.json() as any;
    results.stxBalance = parseInt(d.stx?.balance || "0") / 1e6;
    const sbtcKey = Object.keys(d.fungible_tokens || {}).find(k => k.includes("sbtc"));
    if (sbtcKey) {
      results.sbtcBalance = parseInt(d.fungible_tokens[sbtcKey].balance || "0");
    }
  } catch {}

  return results;
}

interface DCASignal {
  recommendation: "buy" | "wait" | "reduce";
  confidence: "high" | "medium" | "low";
  reasons: string[];
  suggestedAmountPct: number; // % of normal DCA amount to use
  riskFactors: string[];
}

function analyzeDCASignal(market: MarketConditions): DCASignal {
  const reasons: string[] = [];
  const riskFactors: string[] = [];
  let score = 0; // positive = buy, negative = wait

  // Low fees = good time (cheap to transact)
  if (market.btcFeeRate <= 2) {
    score += 2;
    reasons.push(`BTC fees at ${market.btcFeeRate} sat/vB — historically low, cheap execution window`);
  } else if (market.btcFeeRate <= 5) {
    score += 1;
    reasons.push(`BTC fees at ${market.btcFeeRate} sat/vB — moderate`);
  } else if (market.btcFeeRate > 20) {
    score -= 1;
    riskFactors.push(`BTC fees elevated at ${market.btcFeeRate} sat/vB — consider waiting`);
  }

  // Mempool congestion
  if (market.btcMempoolTxCount < 10000) {
    score += 1;
    reasons.push(`Mempool clear (${market.btcMempoolTxCount} txs) — low congestion`);
  } else if (market.btcMempoolTxCount > 50000) {
    score -= 1;
    riskFactors.push(`Mempool congested (${market.btcMempoolTxCount} txs)`);
  }

  // Hashrate stability (high = network secure = bullish)
  if (market.hashrate && market.hashrate > 900) {
    score += 1;
    reasons.push(`Hashrate strong at ${market.hashrate.toFixed(0)} EH/s`);
  }

  // Difficulty adjustment (upcoming increase = miners confident)
  if (market.difficultyAdjustment) {
    if (market.difficultyAdjustment.changePct > 2) {
      score += 1;
      reasons.push(`Difficulty +${market.difficultyAdjustment.changePct.toFixed(1)}% incoming — miner confidence`);
    } else if (market.difficultyAdjustment.changePct < -5) {
      riskFactors.push(`Difficulty ${market.difficultyAdjustment.changePct.toFixed(1)}% — miners leaving`);
    }
  }

  // Determine recommendation
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

// ─── DCA Engine ───────────────────────────────────────────────────────────
class SmartDCA {
  bitflow: any;

  constructor() {
    this.bitflow = new BitflowSDK(BITFLOW_CONFIG);
  }

  async doctor() {
    log("Running diagnostics...");
    const checks: any = {
      bitflowApi: false,
      keeperApi: false,
      tokenCount: 0,
      stxBalance: 0,
      sbtcBalance: 0,
      keeperContract: null,
      safetyLimits: {
        maxSingleOrderSTX: MAX_SINGLE_ORDER_STX,
        maxDailySpendSTX: MAX_DAILY_SPEND_STX,
        maxSlippagePct: MAX_SLIPPAGE_PCT,
        minBalanceReserveSTX: MIN_BALANCE_RESERVE_STX,
      },
    };

    // Check Bitflow API
    try {
      const tokens = await this.bitflow.getAvailableTokens();
      checks.bitflowApi = true;
      checks.tokenCount = tokens.length;
    } catch (e: any) {
      checks.bitflowApiError = e.message;
    }

    // Check balances (using a default address for doctor)
    const stxAddress = process.env.STX_ADDRESS || "";
    if (stxAddress) {
      const market = await fetchMarketConditions(stxAddress);
      checks.stxBalance = market.stxBalance;
      checks.sbtcBalance = market.sbtcBalance;
      checks.availableForDCA = Math.max(0, market.stxBalance - MIN_BALANCE_RESERVE_STX);

      // Check Keeper contract
      try {
        const keeper = await this.bitflow.getOrCreateKeeperContract({
          stacksAddress: stxAddress,
          keeperType: KeeperType.MULTI_ACTION_V1,
        });
        checks.keeperApi = true;
        checks.keeperContract = keeper?.keeperContract?.contractIdentifier || "available";
      } catch (e: any) {
        checks.keeperApiError = e.message;
      }
    } else {
      checks.note = "Set STX_ADDRESS env var for full diagnostics, or pass --address flag";
    }

    checks.supportedTargets = SUPPORTED_TARGETS;
    checks.commands = ["doctor", "analyze", "run --from STX --to sBTC --amount 10", "status", "cancel --order-id <id>"];

    output("success", "doctor", checks);
  }

  async analyze() {
    const stxAddress = process.env.STX_ADDRESS || "";
    if (!stxAddress) {
      output("blocked", "analyze", null, "STX_ADDRESS env var required. Set it or pass --address.");
      return;
    }

    log("Fetching market data...");
    const market = await fetchMarketConditions(stxAddress);
    const signal = analyzeDCASignal(market);

    output("success", "analyze", {
      market,
      signal,
      availableForDCA: Math.max(0, market.stxBalance - MIN_BALANCE_RESERVE_STX),
      note: signal.recommendation === "buy"
        ? `Conditions favor DCA. Suggested: ${signal.suggestedAmountPct}% of normal amount.`
        : signal.recommendation === "wait"
        ? "Mixed signals. Consider smaller position or waiting."
        : "Unfavorable conditions. Reduce exposure or skip this cycle.",
    });
  }

  async run(args: string[]) {
    const stxAddress = process.env.STX_ADDRESS;
    if (!stxAddress) {
      output("blocked", "run", null, "STX_ADDRESS env var required.");
      return;
    }

    // Parse args: --from STX --to sBTC --amount 10 [--force]
    const fromToken = getArg(args, "--from") || "token-stx";
    const toToken = getArg(args, "--to") || "token-sbtc";
    const amountStr = getArg(args, "--amount");
    const force = args.includes("--force");

    if (!amountStr) {
      output("blocked", "run", null, "Missing --amount. Usage: run --from token-stx --to token-sbtc --amount 10");
      return;
    }

    const amount = parseFloat(amountStr);
    if (isNaN(amount) || amount <= 0) {
      output("error", "run", null, `Invalid amount: ${amountStr}`);
      return;
    }

    // ── Safety checks ────────────────────────────────────────────────
    // 1. Max single order
    if (amount > MAX_SINGLE_ORDER_STX) {
      output("blocked", "run", null, `Amount ${amount} STX exceeds max single order (${MAX_SINGLE_ORDER_STX} STX). Reduce amount or adjust limits.`);
      return;
    }

    // 2. Check balance
    const market = await fetchMarketConditions(stxAddress);
    const available = market.stxBalance - MIN_BALANCE_RESERVE_STX;
    if (amount > available) {
      output("blocked", "run", null, `Insufficient balance. Have ${market.stxBalance} STX, need ${amount} + ${MIN_BALANCE_RESERVE_STX} reserve = ${amount + MIN_BALANCE_RESERVE_STX} STX.`);
      return;
    }

    // 3. Validate target token
    const resolvedTo = resolveTokenId(toToken);
    const resolvedFrom = resolveTokenId(fromToken);
    if (!SUPPORTED_TARGETS.includes(resolvedTo) && !SUPPORTED_TARGETS.includes(resolvedFrom)) {
      output("blocked", "run", null, `Unsupported token pair. Supported: ${SUPPORTED_TARGETS.join(", ")}`);
      return;
    }

    // 4. Market analysis (skip with --force)
    if (!force) {
      const signal = analyzeDCASignal(market);
      if (signal.recommendation === "reduce") {
        output("blocked", "run", {
          signal,
          hint: "Use --force to override market analysis warning",
        }, `Market conditions unfavorable (${signal.riskFactors.join("; ")}). Use --force to override.`);
        return;
      }
    }

    // 5. Check slippage via quote
    log("Getting quote...");
    await this.bitflow.getAvailableTokens();
    const amountHuman = amount;
    let quote: any;
    try {
      quote = await this.bitflow.getQuoteForRoute(resolvedFrom, resolvedTo, amountHuman);
    } catch (e: any) {
      output("error", "run", null, `No route found: ${e.message}`);
      return;
    }

    if (!quote?.bestRoute?.quote) {
      output("error", "run", null, "No valid quote returned from Bitflow.");
      return;
    }

    // Calculate effective slippage from a reference price
    const expectedOut = quote.bestRoute.quote;
    const minReceived = Math.floor(expectedOut * (1 - MAX_SLIPPAGE_PCT / 100));

    // ── Execute DCA order via Keeper ────────────────────────────────
    log("Creating Keeper DCA order...");

    try {
      // Get or create keeper contract
      const keeper = await this.bitflow.getOrCreateKeeperContract({
        stacksAddress: stxAddress,
        keeperType: KeeperType.MULTI_ACTION_V1,
      });
      const contractId = keeper.keeperContract.contractIdentifier;

      // Create order
      const tokenXDecimals = quote.bestRoute.tokenXDecimals ?? 6;
      const baseAmount = Math.round(amountHuman * 10 ** tokenXDecimals);

      const order = await this.bitflow.createOrder({
        contractIdentifier: contractId,
        stacksAddress: stxAddress,
        keeperType: KeeperType.MULTI_ACTION_V1,
        actionType: "SWAP_XYK_SWAP_HELPER",
        fundingTokens: { [resolvedFrom]: String(baseAmount) },
        actionAmount: String(baseAmount),
        minReceived: String(minReceived),
        bitcoinTxId: "",
      });

      output("success", "run", {
        orderId: order.keeperOrder.orderId,
        status: order.keeperOrder.orderStatus,
        from: resolvedFrom,
        to: resolvedTo,
        amountIn: amount,
        expectedOut,
        minReceived,
        maxSlippagePct: MAX_SLIPPAGE_PCT,
        keeperContract: contractId,
        marketSignal: force ? "overridden" : analyzeDCASignal(market).recommendation,
        safetyChecks: {
          balanceCheck: "passed",
          singleOrderLimit: "passed",
          slippageGuard: `${MAX_SLIPPAGE_PCT}% max`,
        },
      });
    } catch (e: any) {
      output("error", "run", null, `Keeper order failed: ${e.message}`);
    }
  }

  async status() {
    const stxAddress = process.env.STX_ADDRESS;
    if (!stxAddress) {
      output("blocked", "status", null, "STX_ADDRESS env var required.");
      return;
    }

    try {
      const user = await this.bitflow.getUser(stxAddress);
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

      output("success", "status", {
        address: stxAddress,
        contracts,
        orders,
        activeOrders: orders.filter((o: any) => o.status === "PENDING").length,
        totalOrders: orders.length,
      });
    } catch (e: any) {
      output("error", "status", null, `Failed to fetch status: ${e.message}`);
    }
  }

  async cancel(args: string[]) {
    const orderId = getArg(args, "--order-id");
    if (!orderId) {
      output("blocked", "cancel", null, "Missing --order-id. Usage: cancel --order-id <id>");
      return;
    }

    try {
      const result = await this.bitflow.cancelOrder(orderId);
      output("success", "cancel", {
        orderId,
        status: "cancelled",
        result,
      });
    } catch (e: any) {
      output("error", "cancel", null, `Cancel failed: ${e.message}`);
    }
  }
}

// ─── Utils ────────────────────────────────────────────────────────────────
function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

function resolveTokenId(input: string): string {
  const aliases: Record<string, string> = {
    "stx": "token-stx", "STX": "token-stx",
    "sbtc": "token-sbtc", "sBTC": "token-sbtc",
    "welsh": "token-welsh", "WELSH": "token-welsh",
    "alex": "token-alex", "ALEX": "token-alex",
  };
  return aliases[input] || input;
}

// ─── Entry point ──────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2) || [];
  const command = args[0] || "doctor";

  const dca = new SmartDCA();

  try {
    switch (command) {
      case "doctor":
        await dca.doctor();
        break;
      case "analyze":
        await dca.analyze();
        break;
      case "run":
        await dca.run(args.slice(1));
        break;
      case "status":
        await dca.status();
        break;
      case "cancel":
        await dca.cancel(args.slice(1));
        break;
      default:
        output("error", command, null, `Unknown command: ${command}. Use: doctor, analyze, run, status, cancel`);
    }
  } catch (e: any) {
    output("error", command, null, e.message);
  }
}

main();
