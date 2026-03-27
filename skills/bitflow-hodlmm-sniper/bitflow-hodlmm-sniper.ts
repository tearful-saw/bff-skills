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

// --- Config -----------------------------------------------------------------
const BITFLOW_CONFIG = {
  BITFLOW_API_HOST: "https://bitflowsdk-api-test-7owjsmt8.uk.gateway.dev",
  READONLY_CALL_API_HOST: "https://api.hiro.so",
  BITFLOW_PROVIDER_ADDRESS: "",
  READONLY_CALL_API_KEY: "",
  KEEPER_API_HOST: "",
};

const HIRO_API = "https://api.hiro.so";

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
  // Clarity uint: byte 0x01 + 16-byte big-endian uint128
  if (clean.startsWith("01") && clean.length === 34) {
    return BigInt("0x" + clean.slice(2));
  }
  // Clarity bool true/false
  if (clean === "03") return 1n;
  if (clean === "04") return 0n;
  return BigInt("0x" + clean);
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
    fetch(url, { headers: { Accept: "application/json" } }),
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
      headers: { "Content-Type": "application/json" },
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
  fees: {
    xProtocolBps: number;
    xProviderBps: number;
    yProtocolBps: number;
    yProviderBps: number;
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

  // Depth score based on total value locked (approximated in X terms)
  const tvlInX = resX * 2; // Constant-product: TVL ~ 2 * reserveX
  let depthScore: string;
  if (tvlInX > 1_000_000) depthScore = "deep";
  else if (tvlInX > 100_000) depthScore = "moderate";
  else if (tvlInX > 10_000) depthScore = "shallow";
  else depthScore = "very-shallow";

  const totalFeeBps =
    state.xProtocolFeeBps +
    state.xProviderFeeBps +
    state.yProtocolFeeBps +
    state.yProviderFeeBps;

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
    reasons.push(`Deep liquidity: ${formatNum(resX)} ${state.pool.tokenXSymbol} + ${formatNum(resY)} ${state.pool.tokenYSymbol}`);
  } else if (depthScore === "moderate") {
    score += 1;
    reasons.push("Moderate liquidity depth");
  } else {
    score -= 1;
    reasons.push("Shallow pool -- higher price impact risk");
  }

  // Fees
  if (totalFeeBps >= 60) {
    score += 2;
    reasons.push(`High swap fees (${totalFeeBps} bps) generate strong LP income`);
  } else if (totalFeeBps >= 20) {
    score += 1;
    reasons.push(`Standard swap fees (${totalFeeBps} bps)`);
  } else {
    reasons.push(`Low fees (${totalFeeBps} bps) -- limited LP income`);
  }

  // IL risk at 25% price move
  const il25 = Math.abs(calculateIL(1.25));
  if (il25 < 0.005) {
    score += 1;
    reasons.push("Low IL risk at moderate price moves");
  }

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
      fees: {
        xProtocolBps: state.xProtocolFeeBps,
        xProviderBps: state.xProviderFeeBps,
        yProtocolBps: state.yProtocolFeeBps,
        yProviderBps: state.yProviderFeeBps,
        totalFeeBps,
      },
      ilSimulation,
      entryRecommendation: { signal, confidence, reasons },
    };
  }
}

// --- Commands ---------------------------------------------------------------
class HODLMMSniper {
  sdk: any;

  constructor() {
    this.sdk = new BitflowSDK(BITFLOW_CONFIG);
  }

  async doctor() {
    log("Running diagnostics...");

    // Check Bitflow API
    let bitflowReachable = false;
    let tokenCount = 0;
    try {
      const tokens = await withTimeout(
        this.sdk.getAvailableTokens(),
        10000,
        "Bitflow getAvailableTokens"
      );
      bitflowReachable = true;
      tokenCount = tokens.length;
    } catch (e: any) {
      log(`Bitflow API error: ${e.message}`);
    }

    await delay(API_DELAY_MS);

    // Check Hiro API
    let hiroReachable = false;
    try {
      const r = await withTimeout(
        fetch(`${HIRO_API}/extended/v1/info/network_block_times`),
        10000,
        "Hiro API health"
      );
      hiroReachable = r.ok;
    } catch (e: any) {
      log(`Hiro API error: ${e.message}`);
    }

    await delay(API_DELAY_MS);

    // Test pool read on first pool
    let poolReadable = false;
    let testPoolReserveX = "0";
    try {
      const rx = await readDataVar(POOL_REGISTRY[0].contract, "x-balance");
      poolReadable = rx > 0n;
      testPoolReserveX = rx.toString();
    } catch (e: any) {
      log(`Pool read test failed: ${e.message}`);
    }

    if (!bitflowReachable && !hiroReachable) {
      output("error", "doctor", null, "Both Bitflow and Hiro APIs are unreachable");
      return;
    }

    output("success", "doctor", {
      bitflow: { reachable: bitflowReachable, tokenCount },
      hiro: { reachable: hiroReachable },
      poolRegistry: POOL_REGISTRY.length,
      poolReadable,
      testPool: {
        contract: POOL_REGISTRY[0].contract,
        pair: `${POOL_REGISTRY[0].tokenXSymbol}/${POOL_REGISTRY[0].tokenYSymbol}`,
        reserveX: testPoolReserveX,
      },
      pools: POOL_REGISTRY.map((p) => ({
        pair: `${p.tokenXSymbol}/${p.tokenYSymbol}`,
        contract: p.contract,
      })),
      ilScenarios: IL_SCENARIOS,
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

    output("success", "run", {
      analyzedAt: new Date().toISOString(),
      poolsAnalyzed: analyses.length,
      poolsErrored: errors.length,
      analyses,
      errors: errors.length > 0 ? errors : undefined,
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
  const command = process.argv[2] || Bun?.argv?.[2] || "run";

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
