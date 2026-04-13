#!/usr/bin/env bun
/**
 * bitflow-alex-spread-scanner — Cross-DEX spread scanner for Stacks
 *
 * Detects price discrepancies between Bitflow and Alex DEXes.
 * Calculates round-trip profitability after fees.
 * Read-only: no transactions, no wallet access.
 *
 * Commands:
 *   doctor  — check API connectivity, discover common token pairs
 *   run     — scan all pairs for arbitrage opportunities
 */

import { BitflowSDK } from "@bitflowlabs/core-sdk";
import { AlexSDK, Currency } from "alex-sdk";

// Suppress unhandled rejections from Bitflow SDK's lazy/eager internal init when
// the configured API host is unreachable. Without this, doctor's partial-failure
// path can crash before fetchBitflowTokens()'s try/catch reports the error.
// (Same workaround pattern used by skills/dca.)
process.on("unhandledRejection", (reason: any) => {
  console.error("[spread-scanner][unhandled-rejection]", reason?.message || reason);
});

// Max human amount this skill is designed for. Higher values risk JS float precision
// loss in base-unit conversion (human * 10^decimals). Scan amounts are capped at 100 STX,
// but intermediate amounts from Bitflow/Alex quotes could exceed this for very low-priced
// tokens — guard with an explicit ceiling to fail loud rather than silently mis-quote.
const MAX_SAFE_HUMAN_AMOUNT = 1e12;

// ─── Config ───────────────────────────────────────────────────────────────
const BITFLOW_CONFIG = {
  BITFLOW_API_HOST: process.env.BITFLOW_API_HOST || "https://api.bitflowapis.finance",
  BITFLOW_API_KEY: process.env.BITFLOW_API_KEY || "",
  READONLY_CALL_API_HOST: process.env.READONLY_CALL_API_HOST || "https://api.hiro.so",
  BITFLOW_PROVIDER_ADDRESS: "",
  READONLY_CALL_API_KEY: process.env.HIRO_API_KEY || process.env.READONLY_CALL_API_KEY || "",
  KEEPER_API_HOST: "",
};

const GAS_BUFFER_STX = 0.5; // conservative 2-tx STX fee buffer
const MIN_PROFIT_PCT = 0.1; // report opportunities with netProfitPct above this
const SCAN_AMOUNTS_STX = [1, 10, 50, 100]; // multi-size scan
const INTER_PAIR_DELAY_MS = 500; // delay between pairs to respect Hiro rate limits
const INTRA_PAIR_DELAY_MS = 200; // delay between amount scans within a pair
const MAX_ERROR_LOGS = 5; // suppress after N quote errors to avoid log flood
const DEGRADED_FAILURE_THRESHOLD = 0.2; // >20% scan-pair failures → status: degraded

// Quote-level error counter (module-level — used by scanner instance)
let quoteErrorCount = 0;
function logQuoteError(context: string, err: any) {
  quoteErrorCount++;
  if (quoteErrorCount <= MAX_ERROR_LOGS) {
    console.error("[spread-scanner][quote-err]", context, "-", err?.message || String(err));
  } else if (quoteErrorCount === MAX_ERROR_LOGS + 1) {
    console.error("[spread-scanner][quote-err] further errors suppressed");
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────
function output(status: string, action: string, data: any, error: any = null) {
  console.log(JSON.stringify({ status, action, data, error }));
}

function log(...args: any[]) {
  console.error("[spread-scanner]", ...args);
}

function toBaseUnits(human: number, decimals: number): bigint {
  if (!Number.isFinite(human) || human < 0) {
    throw new Error(`toBaseUnits: invalid human amount ${human}`);
  }
  if (human > MAX_SAFE_HUMAN_AMOUNT) {
    throw new Error(`toBaseUnits: amount ${human} exceeds MAX_SAFE_HUMAN_AMOUNT (${MAX_SAFE_HUMAN_AMOUNT}); increase cap only after verifying JS-float precision headroom`);
  }
  // toFixed forces decimal notation and caps precision at `decimals` digits,
  // avoiding scientific-notation edge cases and high-decimal float drift.
  const fixed = human.toFixed(decimals);
  const [whole, frac = ""] = fixed.split(".");
  const paddedFrac = frac.padEnd(decimals, "0");
  return BigInt(whole) * BigInt(10) ** BigInt(decimals) + BigInt(paddedFrac || "0");
}

function toHuman(base: bigint, decimals: number): number {
  // Note: Number() loses IEEE-754 precision for bigints > 2^53. The MAX_SAFE_HUMAN_AMOUNT
  // input guard on toBaseUnits keeps round-trip values well within safe range for the scan
  // sizes documented in SCAN_AMOUNTS_STX. If you raise that cap, revisit this conversion.
  return Number(base) / 10 ** decimals;
}

// ─── Token mapping ────────────────────────────────────────────────────────
interface TokenMapping {
  bitflowId: string;
  alexCurrency: string;
  symbol: string;
  bitflowDecimals: number;
  alexDecimals: number;
  contract?: string;
}

type ConfidenceTier = "high" | "medium" | "low";

interface ArbResult {
  pair: string;
  direction: "buy_bitflow_sell_alex" | "buy_alex_sell_bitflow";
  buyDex: "Bitflow" | "Alex";
  sellDex: "Bitflow" | "Alex";
  inputAmount: number;
  inputToken: string;
  intermediateAmount: number;
  intermediateToken: string;
  outputAmount: number;
  outputToken: string;
  grossProfitPct: number;
  netProfitSTX: number;
  netProfitPct: number;
  confidence: ConfidenceTier;
}

// ─── Scanner ──────────────────────────────────────────────────────────────
class ArbScanner {
  bitflow: BitflowSDK;
  alex: AlexSDK;
  tokenMap: Map<string, TokenMapping> = new Map();
  pairs: [string, string][] = [];

  constructor() {
    this.bitflow = new BitflowSDK(BITFLOW_CONFIG);
    this.alex = new AlexSDK();
  }

  async fetchBitflowTokens(): Promise<{ tokens: any[] | null; error: string | null }> {
    try {
      const tokens = await this.bitflow.getAvailableTokens();
      log(`Bitflow: ${tokens.length} tokens`);
      return { tokens, error: null };
    } catch (e: any) {
      log(`Bitflow API failed: ${e?.message || e}`);
      return { tokens: null, error: e?.message || String(e) };
    }
  }

  async fetchAlexTokens(): Promise<{ tokens: any[] | null; error: string | null }> {
    try {
      const tokens = await this.alex.fetchSwappableCurrency();
      log(`Alex: ${tokens.length} tokens`);
      return { tokens, error: null };
    } catch (e: any) {
      log(`Alex API failed: ${e?.message || e}`);
      return { tokens: null, error: e?.message || String(e) };
    }
  }

  indexTokens(bfTokens: any[], alexTokens: any[]) {
    // Index Alex tokens by contract address (strip ::asset)
    const alexByContract = new Map<string, any>();
    for (const t of alexTokens) {
      if (t.wrapToken) {
        alexByContract.set(t.wrapToken.split("::")[0], t);
      }
      if (t.underlyingToken) {
        alexByContract.set(t.underlyingToken.split("::")[0], t);
      }
    }

    // Cross-reference by contract
    for (const bf of bfTokens) {
      const bfContract = bf.tokenContract || bf.tokenId;
      let alexToken = alexByContract.get(bfContract);

      // Special case: STX
      if (bf.tokenId === "token-stx" || bf.symbol?.toUpperCase() === "STX") {
        alexToken = alexTokens.find((t: any) => t.id === Currency.STX);
      }

      if (alexToken) {
        this.tokenMap.set(bf.tokenId, {
          bitflowId: bf.tokenId,
          alexCurrency: alexToken.id,
          symbol: bf.symbol || alexToken.name || bf.tokenId,
          bitflowDecimals: bf.tokenDecimals ?? 6,
          alexDecimals: alexToken.underlyingTokenDecimals ?? alexToken.wrapTokenDecimals ?? 6,
          contract: bfContract,
        });
      }
    }

    log(`Matched tokens: ${this.tokenMap.size}`);
  }

  async buildTokenMap() {
    log("Fetching token lists...");
    const bfResult = await this.fetchBitflowTokens();
    if (!bfResult.tokens) throw new Error(`Bitflow API failed: ${bfResult.error}`);
    const alexResult = await this.fetchAlexTokens();
    if (!alexResult.tokens) throw new Error(`Alex API failed: ${alexResult.error}`);
    this.indexTokens(bfResult.tokens, alexResult.tokens);
    return { bitflowCount: bfResult.tokens.length, alexCount: alexResult.tokens.length, matchedCount: this.tokenMap.size };
  }

  async discoverPairs() {
    const tokenIds = Array.from(this.tokenMap.keys());
    const pairs: [string, string][] = [];

    // Only scan X/STX pairs — STX is the base currency for practical arb
    // This avoids decimal mismatch between DEXes on cross-pairs
    const stxId = "token-stx";
    if (!this.tokenMap.has(stxId)) {
      log("STX not found in token map, cannot scan");
      this.pairs = [];
      return [];
    }

    for (const tokenId of tokenIds) {
      if (tokenId === stxId) continue;

      // Check Bitflow route: token <-> STX
      try {
        const targets = await this.bitflow.getAllPossibleTokenY(tokenId);
        if (!targets?.includes(stxId)) continue;
      } catch (e: any) {
        logQuoteError(`discoverPairs bitflow route ${tokenId}`, e);
        continue;
      }

      // Check Alex route: token <-> STX
      const mapToken = this.tokenMap.get(tokenId)!;
      const mapSTX = this.tokenMap.get(stxId)!;
      try {
        const route = await this.alex.getRouter(mapToken.alexCurrency as Currency, mapSTX.alexCurrency as Currency);
        if (!route || route.length === 0) continue;
      } catch (e: any) {
        logQuoteError(`discoverPairs alex route ${tokenId}`, e);
        continue;
      }

      pairs.push([stxId, tokenId]);
      log(`  Pair found: STX/${mapToken.symbol}`);
    }

    this.pairs = pairs;
    return pairs;
  }

  async getBitflowQuote(tokenX: string, tokenY: string, amountHuman: number): Promise<number | null> {
    try {
      const quote = await this.bitflow.getQuoteForRoute(tokenX, tokenY, amountHuman);
      return quote?.bestRoute?.quote ?? null;
    } catch (e: any) {
      logQuoteError(`bitflow ${tokenX}→${tokenY} ${amountHuman}`, e);
      return null;
    }
  }

  async getAlexQuote(currencyX: string, amountBase: bigint, currencyY: string): Promise<bigint | null> {
    try {
      return await this.alex.getAmountTo(currencyX as Currency, amountBase, currencyY as Currency);
    } catch (e: any) {
      logQuoteError(`alex ${currencyX}→${currencyY} ${amountBase}`, e);
      return null;
    }
  }

  async scanPair(stxId: string, tokenId: string, amountSTX: number): Promise<ArbResult | null> {
    const stxMap = this.tokenMap.get(stxId)!;
    const tokenMap = this.tokenMap.get(tokenId)!;

    // Bitflow uses on-chain (underlying) decimals for human units
    const BF_STX_DEC = 6; // STX underlying decimals
    const BF_TOKEN_DEC = tokenMap.bitflowDecimals; // token underlying decimals
    // Alex getAmountTo uses 8-decimal (wrap) units for ALL tokens
    const ALEX_DEC = 8;

    let bestResult: ArbResult | null = null;

    // Direction 1: Buy TOKEN on Bitflow with STX, sell TOKEN on Alex for STX
    const bfTokenOut = await this.getBitflowQuote(stxId, tokenId, amountSTX);
    if (bfTokenOut && bfTokenOut > 0) {
      // Convert Bitflow human output to Alex 8-decimal base
      const alexTokenBase = toBaseUnits(bfTokenOut, ALEX_DEC);
      const alexStxOut = await this.getAlexQuote(tokenMap.alexCurrency, alexTokenBase, stxMap.alexCurrency);
      if (alexStxOut && alexStxOut > 0n) {
        const returnSTX = toHuman(alexStxOut, ALEX_DEC);
        const grossProfit = ((returnSTX - amountSTX) / amountSTX) * 100;
        const netProfit = returnSTX - amountSTX - GAS_BUFFER_STX;
        const netProfitPct = (netProfit / amountSTX) * 100;

        if (netProfitPct > (bestResult?.netProfitPct ?? -Infinity)) {
          bestResult = {
            pair: `STX/${tokenMap.symbol}`,
            direction: "buy_bitflow_sell_alex",
            buyDex: "Bitflow",
            sellDex: "Alex",
            inputAmount: amountSTX,
            inputToken: "STX",
            intermediateAmount: Math.round(bfTokenOut * 100) / 100,
            intermediateToken: tokenMap.symbol,
            outputAmount: Math.round(returnSTX * 100) / 100,
            outputToken: "STX",
            grossProfitPct: Math.round(grossProfit * 100) / 100,
            netProfitSTX: Math.round(netProfit * 100) / 100,
            netProfitPct: Math.round(netProfitPct * 100) / 100,
            confidence: netProfitPct > 2 ? "high" : netProfitPct > 0.5 ? "medium" : "low",
          };
        }
      }
    }

    // Direction 2: Buy TOKEN on Alex with STX, sell TOKEN on Bitflow for STX
    const stxBase = toBaseUnits(amountSTX, ALEX_DEC);
    const alexTokenOut = await this.getAlexQuote(stxMap.alexCurrency, stxBase, tokenMap.alexCurrency);
    if (alexTokenOut && alexTokenOut > 0n) {
      // Convert Alex 8-decimal output to Bitflow human units
      const tokenHuman = toHuman(alexTokenOut, ALEX_DEC);
      const bfStxOut = await this.getBitflowQuote(tokenId, stxId, tokenHuman);
      if (bfStxOut && bfStxOut > 0) {
        const grossProfit = ((bfStxOut - amountSTX) / amountSTX) * 100;
        const netProfit = bfStxOut - amountSTX - GAS_BUFFER_STX;
        const netProfitPct = (netProfit / amountSTX) * 100;

        if (netProfitPct > (bestResult?.netProfitPct ?? -Infinity)) {
          bestResult = {
            pair: `STX/${tokenMap.symbol}`,
            direction: "buy_alex_sell_bitflow",
            buyDex: "Alex",
            sellDex: "Bitflow",
            inputAmount: amountSTX,
            inputToken: "STX",
            intermediateAmount: Math.round(tokenHuman * 100) / 100,
            intermediateToken: tokenMap.symbol,
            outputAmount: Math.round(bfStxOut * 100) / 100,
            outputToken: "STX",
            grossProfitPct: Math.round(grossProfit * 100) / 100,
            netProfitSTX: Math.round(netProfit * 100) / 100,
            netProfitPct: Math.round(netProfitPct * 100) / 100,
            confidence: netProfitPct > 2 ? "high" : netProfitPct > 0.5 ? "medium" : "low",
          };
        }
      }
    }

    return bestResult;
  }

  // ─── Commands ───────────────────────────────────────────────────────────
  async doctor() {
    log("Fetching token lists (independently per-API for partial-failure tolerance)...");
    const bfResult = await this.fetchBitflowTokens();
    const alexResult = await this.fetchAlexTokens();

    const bothReachable = bfResult.tokens !== null && alexResult.tokens !== null;

    let matchedCount = 0;
    let commonPairs: any[] = [];
    let scanReadyPairCount = 0;

    if (bothReachable) {
      this.indexTokens(bfResult.tokens!, alexResult.tokens!);
      matchedCount = this.tokenMap.size;
      const pairs = await this.discoverPairs();
      scanReadyPairCount = pairs.length;
      commonPairs = pairs.map(([a, b]) => ({
        tokenA: this.tokenMap.get(a)!.symbol,
        tokenB: this.tokenMap.get(b)!.symbol,
        bitflowIds: [a, b],
        alexIds: [this.tokenMap.get(a)!.alexCurrency, this.tokenMap.get(b)!.alexCurrency],
      }));
    }

    const hiroKeyConfigured = Boolean(BITFLOW_CONFIG.READONLY_CALL_API_KEY);
    const warnings: string[] = [];
    if (!bothReachable) {
      if (!bfResult.tokens) warnings.push(`bitflow_unreachable: ${bfResult.error}`);
      if (!alexResult.tokens) warnings.push(`alex_unreachable: ${alexResult.error}`);
      warnings.push("partial_outage: pair discovery skipped; resolve API connectivity before running scans.");
    }
    if (bothReachable && !hiroKeyConfigured && scanReadyPairCount >= 5) {
      warnings.push(
        `HIRO_API_KEY not set. With ${scanReadyPairCount} scan-ready pairs, Hiro's public rate limit may cause partial scan failures. Set HIRO_API_KEY to avoid degraded runs.`
      );
    }

    output(bothReachable ? "success" : "degraded", "doctor", {
      bitflow: {
        reachable: bfResult.tokens !== null,
        tokenCount: bfResult.tokens?.length ?? 0,
        apiHost: BITFLOW_CONFIG.BITFLOW_API_HOST,
        error: bfResult.error,
      },
      alex: {
        reachable: alexResult.tokens !== null,
        tokenCount: alexResult.tokens?.length ?? 0,
        error: alexResult.error,
      },
      hiro: { apiHost: BITFLOW_CONFIG.READONLY_CALL_API_HOST, apiKeyConfigured: hiroKeyConfigured },
      matchedTokens: matchedCount,
      commonPairs,
      scanReadyPairCount,
      scanAmountsSTX: SCAN_AMOUNTS_STX,
      gasBufferSTX: GAS_BUFFER_STX,
      minProfitPct: MIN_PROFIT_PCT,
      warnings,
    });
  }

  async run() {
    const errorsBefore = quoteErrorCount;
    await this.buildTokenMap();
    await this.discoverPairs();

    if (this.pairs.length === 0) {
      output("blocked", "run", null, "No common token pairs found between Bitflow and Alex");
      return;
    }

    log(`Scanning ${this.pairs.length} pairs at ${SCAN_AMOUNTS_STX.length} sizes...`);
    const opportunities: ArbResult[] = [];
    const pairSummaries: any[] = [];
    let totalScanAttempts = 0;
    let totalScanFailures = 0;
    let pairsWithNoData = 0;

    for (let i = 0; i < this.pairs.length; i++) {
      const [a, b] = this.pairs[i];
      const tokenMap = this.tokenMap.get(b)!;
      log(`  Scanning STX/${tokenMap.symbol}... (${i + 1}/${this.pairs.length})`);

      const pairResults: ArbResult[] = [];
      for (const amt of SCAN_AMOUNTS_STX) {
        totalScanAttempts++;
        try {
          const result = await this.scanPair(a, b, amt);
          if (result) pairResults.push(result);
          else totalScanFailures++;
        } catch (e: any) {
          totalScanFailures++;
          logQuoteError(`scanPair STX/${tokenMap.symbol} @ ${amt} STX`, e);
        }
        await new Promise(r => setTimeout(r, INTRA_PAIR_DELAY_MS));
      }

      if (pairResults.length === 0) pairsWithNoData++;

      // Opportunities: filter on NET profit (after gas), not gross
      const profitable = pairResults.filter(r => r.netProfitPct > MIN_PROFIT_PCT);
      if (profitable.length > 0) {
        profitable.sort((a, b) => b.netProfitPct - a.netProfitPct);
        opportunities.push(profitable[0]);
      }

      // Per-pair spread diagnostic (gross-level — useful even when no net profit)
      const spreads = pairResults.map(r => ({
        amountSTX: r.inputAmount,
        direction: r.direction,
        grossProfitPct: r.grossProfitPct,
        netProfitPct: r.netProfitPct,
        roundTripCostPct: Math.abs(Math.min(r.grossProfitPct, 0)),
      }));
      pairSummaries.push({
        pair: `STX/${tokenMap.symbol}`,
        scansCompleted: pairResults.length,
        scansAttempted: SCAN_AMOUNTS_STX.length,
        spreads,
        bestGrossProfitPct: pairResults.length > 0 ? Math.max(...pairResults.map(r => r.grossProfitPct)) : null,
        bestNetProfitPct: pairResults.length > 0 ? Math.max(...pairResults.map(r => r.netProfitPct)) : null,
        hasOpportunity: profitable.length > 0,
      });

      // Inter-pair delay to respect Hiro per-minute rate limits
      if (i < this.pairs.length - 1) {
        await new Promise(r => setTimeout(r, INTER_PAIR_DELAY_MS));
      }
    }

    opportunities.sort((a, b) => b.netProfitPct - a.netProfitPct);
    const best = opportunities[0];

    const failureRate = totalScanAttempts > 0 ? totalScanFailures / totalScanAttempts : 0;
    const errorsDuringRun = quoteErrorCount - errorsBefore;
    const isDegraded = failureRate > DEGRADED_FAILURE_THRESHOLD;
    const warnings: string[] = [];
    if (isDegraded) {
      warnings.push(
        `high_scan_failure_rate: ${Math.round(failureRate * 100)}% of scan attempts returned no usable quote pair (${totalScanFailures}/${totalScanAttempts}). Likely Hiro API rate limiting. Set HIRO_API_KEY env var to raise the read-only-call quota.`
      );
    }
    if (pairsWithNoData > 0) {
      warnings.push(`${pairsWithNoData}/${this.pairs.length} pairs returned zero quote data across all scan sizes.`);
    }

    output(isDegraded ? "degraded" : "success", "run", {
      scannedAt: new Date().toISOString(),
      scanAmountsSTX: SCAN_AMOUNTS_STX,
      gasBufferSTX: GAS_BUFFER_STX,
      minProfitPct: MIN_PROFIT_PCT,
      pairsScanned: this.pairs.length,
      opportunities,
      pairSummaries,
      scanStats: {
        totalAttempts: totalScanAttempts,
        totalFailures: totalScanFailures,
        failureRate: Math.round(failureRate * 1000) / 1000,
        pairsWithNoData,
        quoteErrorsLogged: errorsDuringRun,
      },
      warnings,
      summary: {
        totalOpportunities: opportunities.length,
        bestOpportunityPair: best?.pair ?? null,
        bestGrossProfitPct: best?.grossProfitPct ?? null,
        bestNetProfitPct: best?.netProfitPct ?? null,
        avgSmallTradeCostPct: pairSummaries.length > 0
          ? Math.round(pairSummaries.reduce((sum, p) => {
              const small = p.spreads.find((s: any) => s.amountSTX === SCAN_AMOUNTS_STX[0]);
              return sum + (small?.roundTripCostPct ?? 0);
            }, 0) / pairSummaries.length * 100) / 100
          : null,
      },
    });
  }
}

// ─── Entry point ──────────────────────────────────────────────────────────
async function main() {
  const command = process.argv[2] || Bun?.argv?.[2] || "run";

  const scanner = new ArbScanner();

  try {
    switch (command) {
      case "doctor":
        await scanner.doctor();
        break;
      case "run":
        await scanner.run();
        break;
      default:
        output("error", command, null, `Unknown command: ${command}. Use 'doctor' or 'run'.`);
    }
  } catch (e: any) {
    output("error", command, null, e.message);
  }
}

main();
