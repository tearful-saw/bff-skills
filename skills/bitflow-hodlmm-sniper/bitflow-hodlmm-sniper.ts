#!/usr/bin/env bun
/**
 * bitflow-hodlmm-sniper -- Bitflow LP pool analyzer for optimal entry
 *
 * Reads on-chain Bitflow XYK pool state (reserves, fees, price).
 * Simulates liquidity provision at current ratios.
 * Calculates expected impermanent loss at user-defined price scenarios.
 * Recommends entry sizing based on pool depth and fee income.
 *
 * Commands:
 *   doctor  -- check API connectivity, discover active pools
 *   run     -- analyze all pools, rank by LP attractiveness
 */

import { BitflowSDK } from "@bitflowlabs/core-sdk";

// Suppress unhandled rejections from Bitflow SDK's lazy/eager internal init when
// the configured API host is unreachable. Same workaround pattern used by skills/dca
// and bitflow-alex-spread-scanner.
process.on("unhandledRejection", (reason: any) => {
  console.error("[hodlmm-sniper][unhandled-rejection]", reason?.message || reason);
});

// --- Config -----------------------------------------------------------------
const HIRO_API = process.env.READONLY_CALL_API_HOST || "https://api.hiro.so";

const BITFLOW_CONFIG = {
  BITFLOW_API_HOST: process.env.BITFLOW_API_HOST || "https://api.bitflowapis.finance",
  BITFLOW_API_KEY: process.env.BITFLOW_API_KEY || "",
  READONLY_CALL_API_HOST: HIRO_API,
  BITFLOW_PROVIDER_ADDRESS: "",
  READONLY_CALL_API_KEY: process.env.HIRO_API_KEY || process.env.READONLY_CALL_API_KEY || "",
  KEEPER_API_HOST: "",
};

const HIRO_API_KEY = process.env.HIRO_API_KEY || process.env.READONLY_CALL_API_KEY || "";
const hiroHeaders: Record<string, string> = { Accept: "application/json" };
if (HIRO_API_KEY) hiroHeaders["x-api-key"] = HIRO_API_KEY;

// IL simulation price move scenarios (multipliers on token Y price)
const IL_SCENARIOS = [0.5, 0.75, 0.9, 1.0, 1.1, 1.25, 1.5, 2.0];
const API_DELAY_MS = 300;

// --- Helpers ----------------------------------------------------------------
function output(status: string, action: string, data: any, error: any = null) {
  console.log(JSON.stringify({ status, action, data, error }));
}

function log(...args: any[]) {
  console.error("[hodlmm-sniper]", ...args);
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label}: timeout after ${ms}ms`)), ms)
    ),
  ]);
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function hexToUint(hex: string): bigint {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  // Clarity uint128: type byte 0x01 + 16-byte big-endian
  if (clean.startsWith("01") && clean.length === 34) {
    return BigInt("0x" + clean.slice(2));
  }
  // Clarity bool true/false
  if (clean === "03") return 1n;
  if (clean === "04") return 0n;
  // Clarity int128 (0x00) or unexpected types — fail loud rather than silently
  // coercing. Prior behaviour returned BigInt("0x" + clean) for any prefix,
  // which would happily decode an optional none (0x09) or a contract principal
  // (0x05/0x06) as a non-zero number. Caller's catch logs and returns null.
  throw new Error(
    `hexToUint: unexpected Clarity type prefix 0x${clean.slice(0, 2)} (full hex: ${clean.slice(0, 36)}${clean.length > 36 ? "..." : ""})`
  );
}

function bigintToNumber(val: bigint, decimals: number): number {
  const str = val.toString();
  if (str.length <= decimals) {
    return Number("0." + str.padStart(decimals, "0"));
  }
  const whole = str.slice(0, str.length - decimals);
  const frac = str.slice(str.length - decimals);
  return Number(whole + "." + frac);
}

/**
 * Calculate impermanent loss for a constant-product AMM.
 * priceRatio = new_price / old_price of token Y relative to token X.
 * Returns IL as a negative fraction (e.g. -0.0057 = 0.57% loss vs hodl).
 */
function calculateIL(priceRatio: number): number {
  if (priceRatio <= 0) return -1;
  const sqrtR = Math.sqrt(priceRatio);
  return 2 * sqrtR / (1 + priceRatio) - 1;
}

// --- Pool Config ------------------------------------------------------------
interface PoolDef {
  contract: string;
  tokenXSymbol: string;
  tokenYSymbol: string;
  tokenXDecimals: number;
  tokenYDecimals: number;
}

// Key Bitflow XYK pools with verified on-chain contracts
const POOL_REGISTRY: PoolDef[] = [
  {
    contract: "SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.xyk-pool-stx-aeusdc-v-1-1",
    tokenXSymbol: "STX",
    tokenYSymbol: "aeUSDC",
    tokenXDecimals: 6,
    tokenYDecimals: 6,
  },
  {
    contract: "SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.xyk-pool-sbtc-stx-v-1-1",
    tokenXSymbol: "sBTC",
    tokenYSymbol: "STX",
    tokenXDecimals: 8,
    tokenYDecimals: 6,
  },
  {
    contract: "SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.xyk-pool-welsh-stx-v-1-1",
    tokenXSymbol: "WELSH",
    tokenYSymbol: "STX",
    tokenXDecimals: 6,
    tokenYDecimals: 6,
  },
  {
    contract: "SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.xyk-pool-pepe-stx-v-1-1",
    tokenXSymbol: "PEPE",
    tokenYSymbol: "STX",
    tokenXDecimals: 6,
    tokenYDecimals: 6,
  },
  {
    contract: "SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.xyk-pool-not-stx-v-1-1",
    tokenXSymbol: "NOT",
    tokenYSymbol: "STX",
    tokenXDecimals: 6,
    tokenYDecimals: 6,
  },
];

// --- On-chain Reads ---------------------------------------------------------
async function readDataVar(contractId: string, varName: string): Promise<bigint> {
  const [addr, name] = contractId.split(".");
  const url = `${HIRO_API}/v2/data_var/${addr}/${name}/${varName}?tip=latest`;
  const response = await withTimeout(
    fetch(url, { headers: hiroHeaders }),
    10000,
    `data-var ${contractId}.${varName}`
  );

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} reading ${varName} from ${name}`);
  }

  const data = (await response.json()) as { data: string };
  return hexToUint(data.data);
}

async function callReadOnly(
  contractId: string,
  functionName: string,
  args: string[] = []
): Promise<bigint> {
  const [addr, name] = contractId.split(".");
  const url = `${HIRO_API}/v2/contracts/call-read/${addr}/${name}/${functionName}`;
  const response = await withTimeout(
    fetch(url, {
      method: "POST",
      headers: { ...hiroHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ sender: addr, arguments: args }),
    }),
    10000,
    `read-only ${name}.${functionName}`
  );

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} calling ${functionName}`);
  }

  const data = (await response.json()) as { okay: boolean; result: string };
  if (!data.okay) {
    throw new Error(`Contract call failed: ${functionName}`);
  }

  return hexToUint(data.result);
}

// --- Pool State Reading -----------------------------------------------------
interface PoolState {
  pool: PoolDef;
  reserveX: bigint;
  reserveY: bigint;
  totalSupply: bigint;
  xProtocolFeeBps: number;
  xProviderFeeBps: number;
  yProtocolFeeBps: number;
  yProviderFeeBps: number;
  isActive: boolean;
}

async function readPoolState(pool: PoolDef): Promise<PoolState | null> {
  try {
    // Check if pool is created
    const created = await readDataVar(pool.contract, "pool-created");
    if (created === 0n) {
      log(`  Pool ${pool.tokenXSymbol}/${pool.tokenYSymbol} not yet created`);
      return null;
    }
    await delay(API_DELAY_MS);

    // Read reserves
    const reserveX = await readDataVar(pool.contract, "x-balance");
    await delay(API_DELAY_MS);
    const reserveY = await readDataVar(pool.contract, "y-balance");
    await delay(API_DELAY_MS);

    // Read fees (stored as raw bps values)
    const xProtocolFeeBps = Number(await readDataVar(pool.contract, "x-protocol-fee"));
    await delay(API_DELAY_MS);
    const xProviderFeeBps = Number(await readDataVar(pool.contract, "x-provider-fee"));
    await delay(API_DELAY_MS);
    const yProtocolFeeBps = Number(await readDataVar(pool.contract, "y-protocol-fee"));
    await delay(API_DELAY_MS);
    const yProviderFeeBps = Number(await readDataVar(pool.contract, "y-provider-fee"));
    await delay(API_DELAY_MS);

    // Read LP token supply
    let totalSupply = 0n;
    try {
      totalSupply = await callReadOnly(pool.contract, "get-total-supply");
    } catch (e: any) {
      log(`  Could not read total-supply: ${e.message}`);
    }

    // Pool is active if pool-status is true
    let isActive = true;
    try {
      const status = await readDataVar(pool.contract, "pool-status");
      isActive = status === 1n;
    } catch (e: any) {
      log(`  Could not read pool-status: ${e.message}`);
    }

    return {
      pool,
      reserveX,
      reserveY,
      totalSupply,
      xProtocolFeeBps,
      xProviderFeeBps,
      yProtocolFeeBps,
      yProviderFeeBps,
      isActive,
    };
  } catch (e: any) {
    log(`  Failed to read pool ${pool.contract}: ${e.message}`);
    return null;
  }
}

// --- Pool Analysis ----------------------------------------------------------
interface PoolAnalysis {
  pool: string;
  contract: string;
  tokenX: string;
  tokenY: string;
  isActive: boolean;
  reserveX: string;
  reserveY: string;
  reserveXHuman: number;
  reserveYHuman: number;
  spotPrice: number;
  totalLPTokens: string;
  depthScore: string;
  tvlSTX: number;
  fees: {
    xProtocolBps: number;
    xProviderBps: number;
    yProtocolBps: number;
    yProviderBps: number;
    xDirectionBps: number;
    yDirectionBps: number;
    effectiveSwapFeeBps: number;
    totalFeeBps: number;
  };
  ilSimulation: {
    priceMultiplier: number;
    ilPct: number;
    holdValueNorm: number;
    lpValueNorm: number;
  }[];
  entryRecommendation: {
    signal: "enter" | "wait" | "avoid";
    confidence: "high" | "medium" | "low";
    reasons: string[];
  };
}

function analyzePool(state: PoolState): PoolAnalysis {
  const resX = bigintToNumber(state.reserveX, state.pool.tokenXDecimals);
  const resY = bigintToNumber(state.reserveY, state.pool.tokenYDecimals);

  // Spot price: how much X per 1 Y
  const spotPrice = resY > 0 ? resX / resY : 0;

  // Depth score in STX-equivalent terms.
  // For STX-paired pools (4 of 5: sBTC/STX, WELSH/STX, PEPE/STX, NOT/STX),
  // tokenY is STX so 2 * reserveY is a clean TVL approximation in STX.
  // For STX/aeUSDC, tokenX is STX so 2 * reserveX is the right denominator.
  // Previously this used `tvlInX = resX * 2` for all pools, which mis-classified
  // sBTC/STX (1 sBTC ≈ raw value 1 → tvl=2 STX → "very-shallow") even though
  // 1 sBTC at $100K is $200K of liquidity. Normalizing to STX fixes this.
  const xIsSTX = state.pool.tokenXSymbol === "STX";
  const tvlSTX = xIsSTX ? resX * 2 : resY * 2;
  let depthScore: string;
  if (tvlSTX > 1_000_000) depthScore = "deep";
  else if (tvlSTX > 100_000) depthScore = "moderate";
  else if (tvlSTX > 10_000) depthScore = "shallow";
  else depthScore = "very-shallow";

  // Effective per-swap fee — a single trade only pays fees in ONE direction
  // (x→y OR y→x), not both. Previously summed all 4 fee buckets, which doubled
  // the displayed bps. Now: take the higher of the two single-direction sums,
  // since a trader sees that as the realistic worst-case fee.
  const xDirectionBps = state.xProtocolFeeBps + state.xProviderFeeBps;
  const yDirectionBps = state.yProtocolFeeBps + state.yProviderFeeBps;
  const effectiveSwapFeeBps = Math.max(xDirectionBps, yDirectionBps);
  const totalFeeBps = xDirectionBps + yDirectionBps; // kept for backwards compat in output

  // IL simulation: normalized to $1 each of X and Y at entry
  const ilSimulation = IL_SCENARIOS.map((mult) => {
    const il = calculateIL(mult);
    const holdValueNorm = 1 + mult; // $1 X stays $1, $1 Y becomes $mult
    const lpValueNorm = Math.round(holdValueNorm * (1 + il) * 10000) / 10000;
    return {
      priceMultiplier: mult,
      ilPct: Math.round(il * 10000) / 100,
      holdValueNorm: Math.round(holdValueNorm * 10000) / 10000,
      lpValueNorm,
    };
  });

  // Entry recommendation scoring
  const reasons: string[] = [];
  let score = 0;

  if (!state.isActive) {
    reasons.push("Pool is disabled -- cannot enter");
    return buildResult(-10, reasons);
  }

  if (resX === 0 || resY === 0) {
    reasons.push("Pool is empty -- no liquidity");
    return buildResult(-10, reasons);
  }

  // Depth
  if (depthScore === "deep") {
    score += 2;
    reasons.push(`Deep liquidity: ${formatNum(resX)} ${state.pool.tokenXSymbol} + ${formatNum(resY)} ${state.pool.tokenYSymbol} (~${formatNum(tvlSTX)} STX TVL)`);
  } else if (depthScore === "moderate") {
    score += 1;
    reasons.push(`Moderate liquidity depth (~${formatNum(tvlSTX)} STX TVL)`);
  } else {
    score -= 1;
    reasons.push(`Shallow pool (~${formatNum(tvlSTX)} STX TVL) -- higher price impact risk`);
  }

  // Fees — score on EFFECTIVE per-swap fee (single direction), not totalFeeBps
  // which sums both directions. A trader pays only one direction's fees per swap.
  if (effectiveSwapFeeBps >= 30) {
    score += 2;
    reasons.push(`High per-swap fee (${effectiveSwapFeeBps} bps effective; ${totalFeeBps} bps total across both directions) generates strong LP income`);
  } else if (effectiveSwapFeeBps >= 10) {
    score += 1;
    reasons.push(`Standard per-swap fee (${effectiveSwapFeeBps} bps effective)`);
  } else {
    reasons.push(`Low per-swap fee (${effectiveSwapFeeBps} bps effective) -- limited LP income`);
  }

  // IL bonus removed: previously rewarded `calculateIL(1.25) < 0.5%`, which is
  // mathematically unreachable for any constant-product AMM (XYK pools lose
  // ~0.62% to IL at a 25% move). A "fix" that lowers the threshold or scenario
  // would just trigger for every pool equally, since IL on XYK is purely a
  // function of priceMultiplier — not a pool-specific differentiator. The
  // ilSimulation array in the output already exposes the IL curve so the
  // consuming agent can apply its own pair-volatility model. No score adjustment.

  return buildResult(score, reasons);

  function formatNum(n: number): string {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
    if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
    return n.toFixed(2);
  }

  function buildResult(score: number, reasons: string[]): PoolAnalysis {
    let signal: "enter" | "wait" | "avoid";
    let confidence: "high" | "medium" | "low";

    if (score >= 3) {
      signal = "enter";
      confidence = "high";
    } else if (score >= 1) {
      signal = "enter";
      confidence = "medium";
    } else if (score >= 0) {
      signal = "wait";
      confidence = "low";
    } else {
      signal = "avoid";
      confidence = "medium";
    }

    return {
      pool: `${state.pool.tokenXSymbol}/${state.pool.tokenYSymbol}`,
      contract: state.pool.contract,
      tokenX: state.pool.tokenXSymbol,
      tokenY: state.pool.tokenYSymbol,
      isActive: state.isActive,
      reserveX: state.reserveX.toString(),
      reserveY: state.reserveY.toString(),
      reserveXHuman: Math.round(resX * 100) / 100,
      reserveYHuman: Math.round(resY * 100) / 100,
      spotPrice: Math.round(spotPrice * 100000) / 100000,
      totalLPTokens: state.totalSupply.toString(),
      depthScore,
      tvlSTX: Math.round(tvlSTX * 100) / 100,
      fees: {
        xProtocolBps: state.xProtocolFeeBps,
        xProviderBps: state.xProviderFeeBps,
        yProtocolBps: state.yProtocolFeeBps,
        yProviderBps: state.yProviderFeeBps,
        xDirectionBps,
        yDirectionBps,
        effectiveSwapFeeBps,
        totalFeeBps,
      },
      ilSimulation,
      entryRecommendation: { signal, confidence, reasons },
    };
  }
}

// --- Commands ---------------------------------------------------------------
class HODLMMSniper {
  sdk: BitflowSDK;

  constructor() {
    this.sdk = new BitflowSDK(BITFLOW_CONFIG);
  }

  async doctor() {
    log("Running diagnostics...");

    // Check Bitflow API
    let bitflowReachable = false;
    let tokenCount = 0;
    let bitflowError: string | null = null;
    try {
      const tokens = await withTimeout(
        this.sdk.getAvailableTokens(),
        10000,
        "Bitflow getAvailableTokens"
      );
      bitflowReachable = true;
      tokenCount = tokens.length;
    } catch (e: any) {
      bitflowError = e?.message || String(e);
      log(`Bitflow API error: ${bitflowError}`);
    }

    await delay(API_DELAY_MS);

    // Check Hiro API
    let hiroReachable = false;
    let hiroError: string | null = null;
    try {
      const r = await withTimeout(
        fetch(`${HIRO_API}/extended/v1/info/network_block_times`, { headers: hiroHeaders }),
        10000,
        "Hiro API health"
      );
      hiroReachable = r.ok;
      if (!r.ok) hiroError = `HTTP ${r.status}`;
    } catch (e: any) {
      hiroError = e?.message || String(e);
      log(`Hiro API error: ${hiroError}`);
    }

    await delay(API_DELAY_MS);

    // Test pool read on first pool (only if Hiro is reachable)
    let poolReadable = false;
    let testPoolReserveX = "0";
    let poolError: string | null = null;
    if (hiroReachable) {
      try {
        const rx = await readDataVar(POOL_REGISTRY[0].contract, "x-balance");
        poolReadable = rx > 0n;
        testPoolReserveX = rx.toString();
      } catch (e: any) {
        poolError = e?.message || String(e);
        log(`Pool read test failed: ${poolError}`);
      }
    }

    const allHealthy = bitflowReachable && hiroReachable && poolReadable;
    const noneHealthy = !bitflowReachable && !hiroReachable;
    const status = noneHealthy ? "error" : allHealthy ? "success" : "degraded";

    if (noneHealthy) {
      output("error", "doctor", null, "Both Bitflow and Hiro APIs are unreachable");
      return;
    }

    const warnings: string[] = [];
    if (!bitflowReachable) warnings.push(`bitflow_unreachable: ${bitflowError}`);
    if (!hiroReachable) warnings.push(`hiro_unreachable: ${hiroError}`);
    if (!poolReadable && hiroReachable) warnings.push(`pool_read_failed: ${poolError ?? "unknown"}`);
    if (!HIRO_API_KEY) {
      warnings.push(
        `HIRO_API_KEY not set. With ${POOL_REGISTRY.length} pools and ~7 reads each, the public Hiro rate limit may degrade run scans.`
      );
    }

    output(status, "doctor", {
      bitflow: { reachable: bitflowReachable, tokenCount, apiHost: BITFLOW_CONFIG.BITFLOW_API_HOST, error: bitflowError },
      hiro: { reachable: hiroReachable, apiHost: HIRO_API, apiKeyConfigured: Boolean(HIRO_API_KEY), error: hiroError },
      poolRegistry: POOL_REGISTRY.length,
      poolReadable,
      testPool: {
        contract: POOL_REGISTRY[0].contract,
        pair: `${POOL_REGISTRY[0].tokenXSymbol}/${POOL_REGISTRY[0].tokenYSymbol}`,
        reserveX: testPoolReserveX,
        error: poolError,
      },
      pools: POOL_REGISTRY.map((p) => ({
        pair: `${p.tokenXSymbol}/${p.tokenYSymbol}`,
        contract: p.contract,
      })),
      ilScenarios: IL_SCENARIOS,
      warnings,
    });
  }

  async run() {
    log(`Analyzing ${POOL_REGISTRY.length} Bitflow XYK pools...`);
    const analyses: PoolAnalysis[] = [];
    const errors: string[] = [];

    for (const poolDef of POOL_REGISTRY) {
      const pair = `${poolDef.tokenXSymbol}/${poolDef.tokenYSymbol}`;
      log(`  Reading ${pair}...`);
      try {
        const state = await readPoolState(poolDef);
        if (!state) {
          errors.push(`${pair}: could not read on-chain state`);
          continue;
        }
        const analysis = analyzePool(state);
        analyses.push(analysis);
      } catch (e: any) {
        log(`  Error analyzing ${pair}: ${e.message}`);
        errors.push(`${pair}: ${e.message}`);
      }
    }

    if (analyses.length === 0) {
      output("blocked", "run", { errors }, "No pools could be analyzed");
      return;
    }

    // Sort: enter > wait > avoid, then high > medium > low confidence
    const signalOrder: Record<string, number> = { enter: 0, wait: 1, avoid: 2 };
    const confOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
    analyses.sort((a, b) => {
      const sigDiff =
        signalOrder[a.entryRecommendation.signal] -
        signalOrder[b.entryRecommendation.signal];
      if (sigDiff !== 0) return sigDiff;
      return (
        confOrder[a.entryRecommendation.confidence] -
        confOrder[b.entryRecommendation.confidence]
      );
    });

    const best = analyses[0];
    const failureRate = POOL_REGISTRY.length > 0 ? errors.length / POOL_REGISTRY.length : 0;
    const isDegraded = failureRate > 0.2;
    const warnings: string[] = [];
    if (isDegraded) {
      warnings.push(
        `high_pool_failure_rate: ${Math.round(failureRate * 100)}% of pools could not be read (${errors.length}/${POOL_REGISTRY.length}). Set HIRO_API_KEY env var to raise the read-only-call quota.`
      );
    }

    output(isDegraded ? "degraded" : "success", "run", {
      analyzedAt: new Date().toISOString(),
      poolsAnalyzed: analyses.length,
      poolsErrored: errors.length,
      poolsRegistered: POOL_REGISTRY.length,
      failureRate: Math.round(failureRate * 1000) / 1000,
      analyses,
      errors: errors.length > 0 ? errors : [],
      warnings,
      summary: {
        bestPool: best.pool,
        bestSignal: best.entryRecommendation.signal,
        bestConfidence: best.entryRecommendation.confidence,
        enterCount: analyses.filter((a) => a.entryRecommendation.signal === "enter").length,
        waitCount: analyses.filter((a) => a.entryRecommendation.signal === "wait").length,
        avoidCount: analyses.filter((a) => a.entryRecommendation.signal === "avoid").length,
      },
    });
  }
}

// --- Entry point ------------------------------------------------------------
async function main() {
  const command = process.argv[2] || "run";

  const sniper = new HODLMMSniper();

  try {
    switch (command) {
      case "doctor":
        await sniper.doctor();
        break;
      case "run":
        await sniper.run();
        break;
      default:
        output(
          "error",
          command,
          null,
          `Unknown command: ${command}. Use 'doctor' or 'run'.`
        );
    }
  } catch (e: any) {
    log(`Fatal error: ${e.message}`);
    output("error", command, null, e.message);
  }
}

main();
