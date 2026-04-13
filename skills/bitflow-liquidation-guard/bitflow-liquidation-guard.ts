#!/usr/bin/env bun
/**
 * bitflow-liquidation-guard -- Monitors Zest Protocol (Stacky) borrow positions
 *
 * Reads on-chain lending positions from Stacky (Zest) borrow contract.
 * Calculates health factor, liquidation distance, and risk level.
 * Monitors BTC price via Stacky oracle.
 * Can trigger auto-repay via yield when health factor drops.
 *
 * Commands:
 *   doctor  -- check API connectivity, protocol parameters
 *   run     -- monitor a position by address, assess liquidation risk
 *   execute -- trigger yield-based auto-repay for a position (write)
 */

// --- Config -----------------------------------------------------------------
const HIRO_API = process.env.READONLY_CALL_API_HOST || "https://api.hiro.so";
const HIRO_API_KEY = process.env.HIRO_API_KEY || process.env.READONLY_CALL_API_KEY || "";
const hiroHeaders: Record<string, string> = { Accept: "application/json" };
if (HIRO_API_KEY) hiroHeaders["x-api-key"] = HIRO_API_KEY;

// Zest Protocol (Stacky) contract addresses
const CONTRACTS = {
  borrow: "SPCG3TNZXGFP36E4QGQN92TBM3JYF7E4PHGGR120.stacky-borrow",
  vault: "SPCG3TNZXGFP36E4QGQN92TBM3JYF7E4PHGGR120.stacky-vault",
  oracle: "SPCG3TNZXGFP36E4QGQN92TBM3JYF7E4PHGGR120.stacky-oracle",
  governance: "SPCG3TNZXGFP36E4QGQN92TBM3JYF7E4PHGGR120.stacky-governance",
};

const ONE_8 = 100_000_000n; // 8-decimal fixed point

// Risk thresholds
const HEALTH_CRITICAL = 160_000_000n; // 1.60x -- immediate action needed
const HEALTH_WARNING = 180_000_000n; // 1.80x -- alert, prepare to act
const HEALTH_SAFE = 250_000_000n; // 2.50x -- comfortable buffer

const API_DELAY_MS = 300;

// Strategy names
const STRATEGY_NAMES: Record<number, string> = {
  1: "Zest",
  2: "Granite",
  3: "Hermetica",
};

// --- Helpers ----------------------------------------------------------------
function output(status: string, action: string, data: any, error: any = null) {
  console.log(JSON.stringify({ status, action, data, error }));
}

function log(...args: any[]) {
  console.error("[liq-guard]", ...args);
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
  // Clarity bool
  if (clean === "03") return 1n;
  if (clean === "04") return 0n;
  return BigInt("0x" + clean);
}

function fixed8ToNumber(val: bigint): number {
  return Number(val) / Number(ONE_8);
}

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

// --- Contract Reads ---------------------------------------------------------
async function callReadOnly(
  contractId: string,
  functionName: string,
  args: string[] = []
): Promise<string> {
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
    throw new Error(`HTTP ${response.status} calling ${name}.${functionName}`);
  }

  const data = (await response.json()) as { okay: boolean; result: string };
  if (!data.okay) {
    throw new Error(`Contract call failed: ${name}.${functionName} -> ${data.result}`);
  }

  return data.result;
}

async function callReadOnlyUint(
  contractId: string,
  functionName: string,
  args: string[] = []
): Promise<bigint> {
  const result = await callReadOnly(contractId, functionName, args);
  return hexToUint(result);
}

// Encode a Stacks principal as a Clarity argument
function encodePrincipal(address: string): string {
  // For standard principals (SP...), we need to encode as Clarity principal
  // Clarity type 0x05 = standard principal, 0x06 = contract principal
  // However, the Hiro API accepts hex-encoded Clarity values
  // Simplest approach: use the contract-call API with a string-ascii workaround
  // Actually, Hiro's call-read accepts raw Clarity hex. For principal:
  // 0x0516 + 20-byte hash = standard principal
  // We'll use a different approach: pass via the helper

  // Stacks address to c32 decode
  const decoded = c32ToBytes(address);
  if (!decoded) {
    throw new Error(`Invalid Stacks address: ${address}`);
  }
  // Type 0x05 (standard principal) + version byte + 20 bytes hash160
  return "0x0516" + decoded;
}

function c32ToBytes(address: string): string | null {
  // c32check decode: SP/SM/ST addresses
  const C32_CHARS = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const addr = address.toUpperCase();

  // Strip version prefix (first 2 chars of c32)
  const chars = addr.split("");
  const values: number[] = [];
  for (const c of chars) {
    const idx = C32_CHARS.indexOf(c);
    if (idx < 0) return null;
    values.push(idx);
  }

  // Convert from base32 to bytes
  let bits = "";
  for (const v of values) {
    bits += v.toString(2).padStart(5, "0");
  }

  // Take bytes (skip first byte = version, take next 20 = hash160, skip last 4 = checksum)
  const allBytes: number[] = [];
  for (let i = 0; i < bits.length - (bits.length % 8); i += 8) {
    allBytes.push(parseInt(bits.slice(i, i + 8), 2));
  }

  // Version byte + 20 hash bytes + 4 checksum bytes = 25 bytes
  if (allBytes.length < 25) return null;

  // Return version + 20 hash bytes as hex (skip checksum)
  const hashBytes = allBytes.slice(0, 21);
  return hashBytes.map((b) => b.toString(16).padStart(2, "0")).join("");
}

// --- Position Data ----------------------------------------------------------
interface PositionData {
  strategy: number;
  strategyName: string;
  collateralShares: bigint;
  entrySharePrice: bigint;
  debt: bigint;
  lastRepayHeight: bigint;
}

interface HealthReport {
  address: string;
  hasPosition: boolean;
  position: {
    strategy: number;
    strategyName: string;
    collateralShares: string;
    entrySharePrice: number;
    debtUSD: number;
    lastRepayHeight: string;
  } | null;
  currentSharePrice: number;
  btcPriceUSD: number;
  collateralValueUSD: number;
  healthFactor: number;
  liquidationRatio: number;
  riskLevel: "safe" | "warning" | "critical" | "liquidatable";
  liquidationPrice: number;
  priceDropToLiquidation: number;
  yieldAccrued: number;
  autoRepayAvailable: boolean;
  recommendation: string;
}

async function getPosition(address: string): Promise<PositionData | null> {
  try {
    const principalArg = encodePrincipal(address);
    const result = await callReadOnly(CONTRACTS.borrow, "get-position", [principalArg]);

    // Result is (optional {...}) -- check if it's none (0x09) or some (0x0a...)
    const clean = result.startsWith("0x") ? result.slice(2) : result;
    if (clean.startsWith("09")) {
      return null; // No position
    }

    // Parse the some(tuple) response
    // The tuple has: strategy, collateral-shares, entry-share-price, debt, last-repay-height
    // Clarity encoding for optional-some + tuple is complex; use health-factor as proxy
    // and read individual fields via separate calls

    // We'll use get-health-factor to verify position exists, then parse tuple manually
    // Tuple encoding: 0x0a (some) + 0x0c (tuple) + field count + fields
    // Each field: name-length + name + value

    const tupleData = clean.slice(2); // skip 0x0a (some)
    if (!tupleData.startsWith("0c")) {
      log("  Unexpected tuple format");
      return null;
    }

    // Parse tuple: 0c + 4-byte field count (big endian) + fields
    const fieldCount = parseInt(tupleData.slice(2, 10), 16);
    let offset = 10;

    const fields: Record<string, bigint> = {};
    for (let i = 0; i < fieldCount; i++) {
      // Field name: 1-byte length + ASCII name
      const nameLen = parseInt(tupleData.slice(offset, offset + 2), 16);
      offset += 2;
      const nameHex = tupleData.slice(offset, offset + nameLen * 2);
      const name = Buffer.from(nameHex, "hex").toString("ascii");
      offset += nameLen * 2;

      // Value: type byte + value
      const typeByte = tupleData.slice(offset, offset + 2);
      if (typeByte === "01") {
        // uint128: 16 bytes
        const val = BigInt("0x" + tupleData.slice(offset + 2, offset + 34));
        fields[name] = val;
        offset += 34;
      } else {
        // Skip unknown types
        log(`  Unknown field type ${typeByte} for ${name}`);
        break;
      }
    }

    return {
      strategy: Number(fields["strategy"] || 0n),
      strategyName: STRATEGY_NAMES[Number(fields["strategy"] || 0n)] || "Unknown",
      collateralShares: fields["collateral-shares"] || 0n,
      entrySharePrice: fields["entry-share-price"] || 0n,
      debt: fields["debt"] || 0n,
      lastRepayHeight: fields["last-repay-height"] || 0n,
    };
  } catch (e: any) {
    log(`  Failed to read position for ${address}: ${e.message}`);
    return null;
  }
}

async function getHealthFactor(address: string): Promise<bigint | null> {
  try {
    const principalArg = encodePrincipal(address);
    const result = await callReadOnly(CONTRACTS.borrow, "get-health-factor", [principalArg]);
    const clean = result.startsWith("0x") ? result.slice(2) : result;

    // Result is (optional uint) -- 0x09 = none, 0x0a01... = some(uint)
    if (clean.startsWith("09")) return null;
    if (clean.startsWith("0a01")) {
      return BigInt("0x" + clean.slice(4, 36));
    }
    return null;
  } catch (e: any) {
    log(`  Failed to read health factor: ${e.message}`);
    return null;
  }
}

async function buildHealthReport(address: string): Promise<HealthReport> {
  // Get position
  const position = await getPosition(address);
  await delay(API_DELAY_MS);

  if (!position) {
    return {
      address,
      hasPosition: false,
      position: null,
      currentSharePrice: 0,
      btcPriceUSD: 0,
      collateralValueUSD: 0,
      healthFactor: 0,
      liquidationRatio: 1.5,
      riskLevel: "safe",
      liquidationPrice: 0,
      priceDropToLiquidation: 0,
      yieldAccrued: 0,
      autoRepayAvailable: false,
      recommendation: "No borrow position found for this address.",
    };
  }

  // Get current share price for the position's strategy
  const strategyArg = "0x01" + position.strategy.toString(16).padStart(32, "0");
  const currentSharePrice = await callReadOnlyUint(CONTRACTS.vault, "get-share-price", [
    strategyArg,
  ]);
  await delay(API_DELAY_MS);

  // Get BTC price from oracle
  const btcPrice = await callReadOnlyUint(CONTRACTS.oracle, "get-btc-price");
  await delay(API_DELAY_MS);

  // Get liquidation ratio
  const liquidationRatio = await callReadOnlyUint(CONTRACTS.borrow, "get-liquidation-ratio");
  await delay(API_DELAY_MS);

  // Get health factor
  const healthFactor = await getHealthFactor(address);
  await delay(API_DELAY_MS);

  // Calculate collateral value
  // collateral_assets = shares * share_price / ONE_8
  const collateralAssets =
    (position.collateralShares * currentSharePrice) / ONE_8;
  // collateral_value_usd = collateral_assets * btc_price / ONE_8
  const collateralValueUSD =
    (collateralAssets * btcPrice) / ONE_8;

  const btcPriceNum = fixed8ToNumber(btcPrice);
  const sharePriceNum = fixed8ToNumber(currentSharePrice);
  const healthFactorNum = healthFactor ? fixed8ToNumber(healthFactor) : 0;
  const liquidationRatioNum = fixed8ToNumber(liquidationRatio);
  const debtUSD = Number(position.debt) / 1_000_000; // debt in 6-decimal USD
  const collateralValueNum = fixed8ToNumber(collateralValueUSD);

  // Determine risk level
  let riskLevel: "safe" | "warning" | "critical" | "liquidatable";
  if (!healthFactor || healthFactor === 0n) {
    riskLevel = "safe"; // no debt = infinite health
  } else if (healthFactor < liquidationRatio) {
    riskLevel = "liquidatable";
  } else if (healthFactor < HEALTH_CRITICAL) {
    riskLevel = "critical";
  } else if (healthFactor < HEALTH_WARNING) {
    riskLevel = "warning";
  } else {
    riskLevel = "safe";
  }

  // Calculate liquidation price (BTC price at which health = liquidation ratio)
  // health = collateral_value / debt_value
  // At liquidation: liq_ratio = (shares * share_price * btc_liq_price) / (debt * ONE_8)
  // btc_liq_price = (liq_ratio * debt * ONE_8) / (shares * share_price)
  let liquidationPrice = 0;
  let priceDropToLiquidation = 0;
  if (position.debt > 0n && position.collateralShares > 0n && currentSharePrice > 0n) {
    const debtScaled = position.debt * 100n; // debt is in 6-dec, multiply by 100 to get 8-dec
    const liqPriceBigint =
      (liquidationRatio * debtScaled * ONE_8) /
      (position.collateralShares * currentSharePrice);
    liquidationPrice = fixed8ToNumber(liqPriceBigint);
    if (btcPriceNum > 0) {
      priceDropToLiquidation = Math.round(
        ((btcPriceNum - liquidationPrice) / btcPriceNum) * 10000
      ) / 100;
    }
  }

  // Check if auto-repay (yield-based) is available
  const entryPriceNum = fixed8ToNumber(position.entrySharePrice);
  const yieldAccrued = sharePriceNum > entryPriceNum ? sharePriceNum - entryPriceNum : 0;
  const autoRepayAvailable = yieldAccrued > 0 && position.debt > 0n;

  // Build recommendation
  let recommendation: string;
  switch (riskLevel) {
    case "liquidatable":
      recommendation =
        "URGENT: Position is below liquidation threshold. Repay debt immediately or add collateral to avoid liquidation.";
      break;
    case "critical":
      recommendation =
        "Health factor critical. Consider running 'execute --address <addr>' to trigger yield-based auto-repay, or manually repay debt.";
      break;
    case "warning":
      recommendation =
        "Health factor approaching warning zone. Monitor closely. Auto-repay via yield may help if share price has appreciated.";
      break;
    case "safe":
      recommendation = position.debt > 0n
        ? "Position is healthy. Continue monitoring periodically."
        : "No borrow position found for this address.";
      break;
  }

  return {
    address,
    hasPosition: true,
    position: {
      strategy: position.strategy,
      strategyName: position.strategyName,
      collateralShares: position.collateralShares.toString(),
      entrySharePrice: entryPriceNum,
      debtUSD: debtUSD,
      lastRepayHeight: position.lastRepayHeight.toString(),
    },
    currentSharePrice: sharePriceNum,
    btcPriceUSD: btcPriceNum,
    collateralValueUSD: Math.round(collateralValueNum * 100) / 100,
    healthFactor: Math.round(healthFactorNum * 10000) / 10000,
    liquidationRatio: liquidationRatioNum,
    riskLevel,
    liquidationPrice: Math.round(liquidationPrice * 100) / 100,
    priceDropToLiquidation,
    yieldAccrued: Math.round(yieldAccrued * 100000000) / 100000000,
    autoRepayAvailable,
    recommendation,
  };
}

// --- Commands ---------------------------------------------------------------
class LiquidationGuard {
  async doctor() {
    log("Running diagnostics...");

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

    if (!hiroReachable) {
      output("error", "doctor", null, `Hiro API unreachable: ${hiroError}`);
      return;
    }

    await delay(API_DELAY_MS);

    // Read protocol parameters
    let btcPrice = 0n;
    try {
      btcPrice = await callReadOnlyUint(CONTRACTS.oracle, "get-btc-price");
    } catch (e: any) {
      log(`Oracle read failed: ${e.message}`);
    }

    await delay(API_DELAY_MS);

    let liquidationRatio = 0n;
    try {
      liquidationRatio = await callReadOnlyUint(
        CONTRACTS.borrow,
        "get-liquidation-ratio"
      );
    } catch (e: any) {
      log(`Liquidation ratio read failed: ${e.message}`);
    }

    await delay(API_DELAY_MS);

    let maxLtv = 0n;
    try {
      maxLtv = await callReadOnlyUint(CONTRACTS.borrow, "get-max-ltv");
    } catch (e: any) {
      log(`Max LTV read failed: ${e.message}`);
    }

    await delay(API_DELAY_MS);

    let minBorrow = 0n;
    try {
      minBorrow = await callReadOnlyUint(CONTRACTS.borrow, "get-min-borrow");
    } catch (e: any) {
      log(`Min borrow read failed: ${e.message}`);
    }

    await delay(API_DELAY_MS);

    let totalBorrowed = 0n;
    try {
      totalBorrowed = await callReadOnlyUint(CONTRACTS.borrow, "get-total-borrowed");
    } catch (e: any) {
      log(`Total borrowed read failed: ${e.message}`);
    }

    await delay(API_DELAY_MS);

    // Read share prices for all strategies
    const sharePrices: Record<string, number> = {};
    for (const [id, name] of Object.entries(STRATEGY_NAMES)) {
      try {
        const stratArg = "0x01" + Number(id).toString(16).padStart(32, "0");
        const price = await callReadOnlyUint(CONTRACTS.vault, "get-share-price", [stratArg]);
        sharePrices[name] = fixed8ToNumber(price);
      } catch (e: any) {
        log(`  Share price for ${name} failed: ${e.message}`);
        sharePrices[name] = 0;
      }
      await delay(API_DELAY_MS);
    }

    let tvl = 0n;
    try {
      tvl = await callReadOnlyUint(CONTRACTS.vault, "get-tvl");
    } catch (e: any) {
      log(`TVL read failed: ${e.message}`);
    }

    // Track which protocol reads succeeded — degrade if any failed
    const protocolReads = {
      btcPrice: btcPrice > 0n,
      liquidationRatio: liquidationRatio > 0n,
      maxLtv: maxLtv > 0n,
      minBorrow: minBorrow > 0n,
      totalBorrowed: totalBorrowed >= 0n, // can be 0 legitimately
      tvl: tvl >= 0n,
    };
    const failedReads = Object.entries(protocolReads).filter(([, ok]) => !ok).map(([k]) => k);
    const sharePriceFailures = Object.entries(sharePrices).filter(([, v]) => v === 0).map(([k]) => k);
    const isDegraded = failedReads.length > 0 || sharePriceFailures.length === Object.keys(STRATEGY_NAMES).length;

    const warnings: string[] = [];
    if (failedReads.length > 0) {
      warnings.push(`protocol_reads_failed: ${failedReads.join(", ")}`);
    }
    if (sharePriceFailures.length > 0 && sharePriceFailures.length < Object.keys(STRATEGY_NAMES).length) {
      warnings.push(`partial_strategy_reads: ${sharePriceFailures.join(", ")} returned 0 (likely Hiro rate limit)`);
    }
    if (!HIRO_API_KEY) {
      warnings.push(
        "HIRO_API_KEY not set. The doctor command issues ~10 read-only Hiro calls; without a key, public rate limits may cause partial degradation."
      );
    }

    output(isDegraded ? "degraded" : "success", "doctor", {
      hiro: { reachable: hiroReachable, apiHost: HIRO_API, apiKeyConfigured: Boolean(HIRO_API_KEY), error: hiroError },
      contracts: CONTRACTS,
      protocol: {
        btcPriceUSD: fixed8ToNumber(btcPrice),
        liquidationRatio: fixed8ToNumber(liquidationRatio),
        maxLTV: fixed8ToNumber(maxLtv),
        minBorrowUSD: Number(minBorrow) / 1_000_000,
        totalBorrowedUSD: Number(totalBorrowed) / 1_000_000,
        vaultTVL: tvl.toString(),
      },
      protocolReadStatus: protocolReads,
      strategies: sharePrices,
      riskThresholds: {
        critical: fixed8ToNumber(HEALTH_CRITICAL),
        warning: fixed8ToNumber(HEALTH_WARNING),
        safe: fixed8ToNumber(HEALTH_SAFE),
      },
      commands: [
        "doctor",
        "run --address <STX_ADDRESS>",
        "execute --address <STX_ADDRESS> (builds yield-auto-repay tx data; broadcast separately)",
      ],
      warnings,
    });
  }

  async run(args: string[]) {
    const address = getArg(args, "--address") || process.env.STX_ADDRESS;
    if (!address) {
      output(
        "blocked",
        "run",
        null,
        "Missing --address. Usage: run --address SP1234... (or set STX_ADDRESS env var)"
      );
      return;
    }

    // Validate address format
    if (!address.startsWith("SP") && !address.startsWith("SM") && !address.startsWith("ST")) {
      output("error", "run", null, `Invalid Stacks address format: ${address}`);
      return;
    }

    log(`Checking position for ${address}...`);
    const report = await buildHealthReport(address);

    if (!report.hasPosition) {
      output("success", "run", {
        address,
        hasPosition: false,
        recommendation: "No borrow position found for this address.",
        btcPriceUSD: report.btcPriceUSD,
      });
      return;
    }

    output("success", "run", report);
  }

  async execute(args: string[]) {
    const address = getArg(args, "--address") || process.env.STX_ADDRESS;
    if (!address) {
      output(
        "blocked",
        "execute",
        null,
        "Missing --address. Usage: execute --address SP1234..."
      );
      return;
    }

    log(`Building health report for ${address}...`);
    const report = await buildHealthReport(address);

    if (!report.hasPosition) {
      output("blocked", "execute", null, "No borrow position found for this address.");
      return;
    }

    if (!report.autoRepayAvailable) {
      output("blocked", "execute", {
        healthFactor: report.healthFactor,
        yieldAccrued: report.yieldAccrued,
        reason: "No yield has accrued since entry. Auto-repay requires share price appreciation.",
      }, "Auto-repay not available: no yield accrued.");
      return;
    }

    // Build the trigger-repay transaction data
    // The contract's trigger-repay function takes (user principal)
    // This is a public function anyone can call to trigger yield-based repayment
    const [contractAddr, contractName] = CONTRACTS.borrow.split(".");

    output("success", "execute", {
      action: "trigger-repay",
      description: "Triggers yield-based auto-repay on the Stacky borrow contract. This converts accrued yield into debt repayment.",
      healthBefore: report.healthFactor,
      riskLevel: report.riskLevel,
      yieldAccrued: report.yieldAccrued,
      transaction: {
        contractAddress: contractAddr,
        contractName,
        functionName: "trigger-repay",
        functionArgs: [{ type: "principal", value: address }],
        postConditions: [],
        note: "This transaction requires a wallet signature. The agent should use a signing skill or wallet integration to broadcast.",
      },
      warning: "This will submit an on-chain transaction. Ensure the signing wallet has STX for gas fees (~0.01 STX).",
    });
  }
}

// --- Entry point ------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2) || [];
  const command = args[0] || "doctor";

  const guard = new LiquidationGuard();

  try {
    switch (command) {
      case "doctor":
        await guard.doctor();
        break;
      case "run":
        await guard.run(args.slice(1));
        break;
      case "execute":
        await guard.execute(args.slice(1));
        break;
      default:
        output(
          "error",
          command,
          null,
          `Unknown command: ${command}. Use: doctor, run, execute`
        );
    }
  } catch (e: any) {
    log(`Fatal error: ${e.message}`);
    output("error", command, null, e.message);
  }
}

main();
