#!/usr/bin/env bun
/**
 * zest-collateral-manager — Autonomous sBTC collateral manager for Zest Protocol
 *
 * Supplies sBTC as collateral to Zest Protocol on Stacks mainnet.
 * Monitors position health factor, LTV ratios, and pending STX rewards.
 * Withdraws collateral safely with liquidation-threshold checks.
 * Claims accrued STX stacking rewards.
 *
 * Commands:
 *   doctor         — check wallet, balances, reserve state, oracle
 *   status         — current position: supplied, borrowed, health factor, rewards
 *   supply         — deposit sBTC as collateral (max 50,000 sats)
 *   withdraw       — withdraw sBTC collateral (health factor safe)
 *   claim-rewards  — claim pending STX stacking rewards
 *
 * All commands output strict JSON to stdout.
 * Diagnostic logs go to stderr.
 */

import { Command } from "commander";

// ─── Constants ───────────────────────────────────────────────────────────────

/** Zest Protocol contract deployer */
const DEPLOYER = "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N";

/** Zest Protocol contracts */
const CONTRACTS = {
  borrowHelper: `${DEPLOYER}.borrow-helper-v2-1-7`,
  zsbtc: `${DEPLOYER}.zsbtc-v2-0`,
  poolReserve: `${DEPLOYER}.pool-0-reserve-v2-0`,
  incentives: `${DEPLOYER}.incentives-v2-2`,
  oracle: `${DEPLOYER}.stx-btc-oracle-v1-4`,
} as const;

/** sBTC token contract */
const SBTC_CONTRACT = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";

/** STX token placeholder for reward claiming */
const STX_CONTRACT = `${DEPLOYER}.wstx`;

/** Stacks API for read-only calls */
const STACKS_API = "https://api.hiro.so";

/** sBTC and zsBTC both use 8 decimal places */
const DECIMALS = 8;

/**
 * SAFETY LIMIT: Maximum supply per transaction in sats.
 * Hardcoded — cannot be overridden by CLI args or environment.
 * 50,000 sats = 0.0005 BTC.
 */
const MAX_SUPPLY_SATS = 50_000;

/** Minimum STX balance required for gas (conservative estimate for Zest contract calls) */
const MIN_GAS_STX = 0.5;

/** Minimum health factor allowed after withdrawal — must stay above 1.0 to avoid liquidation */
const MIN_HEALTH_FACTOR = 1.0;

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface OutputEnvelope {
  status: "ok" | "error";
  command: string;
  data: any;
  error?: string;
}

function output(envelope: OutputEnvelope): void {
  console.log(JSON.stringify(envelope));
}

function ok(command: string, data: any): void {
  output({ status: "ok", command, data });
}

function fail(command: string, error: string, data: any = null): void {
  output({ status: "error", command, data, error });
}

function log(...args: any[]): void {
  console.error("[zest-collateral]", ...args);
}

function satsToHuman(sats: number): string {
  return (sats / 10 ** DECIMALS).toFixed(DECIMALS);
}

// ─── Clarity Value Parsing ──────────────────────────────────────────────────

interface ClarityValue {
  type: string;
  value: any;
  repr?: string;
}

/**
 * Parse a Clarity hex value or repr into a usable JS value.
 * Handles: uint, int, bool, optional, ok, err, tuple, none.
 */
function parseClarityValue(raw: any): ClarityValue {
  if (typeof raw === "object" && raw !== null && raw.type) return raw;

  if (typeof raw === "string") {
    const repr = raw;

    // uint
    const uintMatch = repr.match(/^u(\d+)$/);
    if (uintMatch) return { type: "uint", value: BigInt(uintMatch[1]), repr };

    // int
    const intMatch = repr.match(/^(-?\d+)$/);
    if (intMatch) return { type: "int", value: BigInt(intMatch[1]), repr };

    // bool
    if (repr === "true") return { type: "bool", value: true, repr };
    if (repr === "false") return { type: "bool", value: false, repr };

    // none
    if (repr === "none") return { type: "none", value: null, repr };

    // (ok <value>)
    const okMatch = repr.match(/^\(ok (.+)\)$/);
    if (okMatch) return parseClarityValue(okMatch[1]);

    // (some <value>)
    const someMatch = repr.match(/^\(some (.+)\)$/);
    if (someMatch) return { type: "optional", value: parseClarityValue(someMatch[1]), repr };

    // (err <value>)
    const errMatch = repr.match(/^\(err (.+)\)$/);
    if (errMatch) return { type: "err", value: parseClarityValue(errMatch[1]), repr };

    // (tuple ...)  or  { key: val, ... }
    const tupleMatch = repr.match(/^\(tuple (.+)\)$/);
    if (tupleMatch) return parseTupleRepr(tupleMatch[1]);

    // Hex-encoded Clarity value
    if (repr.startsWith("0x")) {
      const hex = repr.slice(2);
      // 0x01 = uint128 (16 bytes)
      if (hex.length >= 34 && hex.startsWith("01")) {
        const numHex = hex.slice(2, 34);
        return { type: "uint", value: BigInt("0x" + numHex), repr };
      }
      // 0x07 = ok response
      if (hex.startsWith("07")) return parseClarityValue("0x" + hex.slice(2));
      // 0x09 = none
      if (hex === "09") return { type: "none", value: null, repr };
      // 0x0a = some
      if (hex.startsWith("0a")) return { type: "optional", value: parseClarityValue("0x" + hex.slice(2)), repr };
      // 0x03 = true, 0x04 = false
      if (hex === "03") return { type: "bool", value: true, repr };
      if (hex === "04") return { type: "bool", value: false, repr };
      // 0x0c = tuple
      if (hex.startsWith("0c")) return parseTupleHex(hex.slice(2));
    }

    return { type: "unknown", value: repr, repr };
  }

  return { type: "unknown", value: raw };
}

/**
 * Parse a tuple from repr format: (key1 val1) (key2 val2) ...
 */
function parseTupleRepr(inner: string): ClarityValue {
  const entries: Record<string, ClarityValue> = {};
  const regex = /\((\S+)\s+([^)]+(?:\([^)]*\))?[^)]*)\)/g;
  let match;
  while ((match = regex.exec(inner)) !== null) {
    entries[match[1]] = parseClarityValue(match[2].trim());
  }
  return { type: "tuple", value: entries };
}

/**
 * Parse a tuple from hex-encoded Clarity.
 * Format: 0c + 4-byte count + (1-byte name-len + name + value)*
 */
function parseTupleHex(hex: string): ClarityValue {
  const entries: Record<string, ClarityValue> = {};
  try {
    let pos = 0;
    // 4-byte big-endian count of entries
    const count = parseInt(hex.slice(pos, pos + 8), 16);
    pos += 8;

    for (let i = 0; i < count && pos < hex.length; i++) {
      // 1-byte name length
      const nameLen = parseInt(hex.slice(pos, pos + 2), 16);
      pos += 2;
      // Name bytes
      const nameHex = hex.slice(pos, pos + nameLen * 2);
      const name = Buffer.from(nameHex, "hex").toString("ascii");
      pos += nameLen * 2;

      // Value type byte
      const typeByte = hex.slice(pos, pos + 2);

      if (typeByte === "01") {
        // uint128: 16 bytes
        const numHex = hex.slice(pos + 2, pos + 34);
        entries[name] = { type: "uint", value: BigInt("0x" + numHex) };
        pos += 34;
      } else if (typeByte === "03") {
        entries[name] = { type: "bool", value: true };
        pos += 2;
      } else if (typeByte === "04") {
        entries[name] = { type: "bool", value: false };
        pos += 2;
      } else if (typeByte === "09") {
        entries[name] = { type: "none", value: null };
        pos += 2;
      } else if (typeByte === "0a") {
        // some - parse inner value recursively
        const innerResult = parseClarityValue("0x" + hex.slice(pos + 2));
        entries[name] = { type: "optional", value: innerResult };
        // Advance past this value — estimate based on type
        pos += 2;
        if (hex.slice(pos, pos + 2) === "01") pos += 34; // uint
        else if (hex.slice(pos, pos + 2) === "03" || hex.slice(pos, pos + 2) === "04") pos += 2;
        else pos += 34; // default advance
      } else {
        // Unknown type — skip (best effort)
        entries[name] = { type: "unknown", value: typeByte };
        pos += 2;
        break; // Can't reliably skip unknown types
      }
    }
  } catch (e: any) {
    log("WARN: Tuple hex parse incomplete:", e.message);
  }
  return { type: "tuple", value: entries };
}

/**
 * Extract a numeric value from a Clarity result.
 */
function clarityToNumber(cv: ClarityValue): number {
  if (cv.type === "uint" || cv.type === "int") return Number(cv.value);
  if (cv.type === "optional" && cv.value) return clarityToNumber(cv.value);
  throw new Error(`Cannot convert Clarity value to number: ${JSON.stringify(cv)}`);
}

/**
 * Extract a boolean from a Clarity result.
 */
function clarityToBool(cv: ClarityValue): boolean {
  if (cv.type === "bool") return cv.value;
  if (cv.type === "optional" && cv.value) return clarityToBool(cv.value);
  throw new Error(`Cannot convert Clarity value to bool: ${JSON.stringify(cv)}`);
}

/**
 * Extract tuple fields from a Clarity result.
 */
function clarityToTuple(cv: ClarityValue): Record<string, ClarityValue> {
  if (cv.type === "tuple") return cv.value;
  throw new Error(`Expected tuple, got ${cv.type}: ${JSON.stringify(cv)}`);
}

// ─── Stacks Read-Only Call Helpers ──────────────────────────────────────────

/**
 * Call a read-only Clarity function via the Hiro API.
 */
async function callReadOnly(
  contract: string,
  fn: string,
  args: string[] = [],
  senderAddress: string = DEPLOYER
): Promise<ClarityValue> {
  const [addr, name] = contract.split(".");
  const url = `${STACKS_API}/v2/contracts/call-read/${addr}/${name}/${fn}`;

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sender: senderAddress,
      arguments: args,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Read-only call ${name}.${fn} failed (${resp.status}): ${text}`);
  }

  const result = (await resp.json()) as any;

  if (!result.okay || result.okay === "false") {
    throw new Error(
      `Read-only call ${name}.${fn} returned not-okay: ${result.cause || JSON.stringify(result)}`
    );
  }

  return result.result ? parseClarityValue(result.result) : { type: "none", value: null };
}

// ─── Address Encoding ───────────────────────────────────────────────────────

/**
 * Convert a Stacks address to hex for Clarity principal encoding.
 * Decodes c32check address to 20-byte hash160.
 */
function addressToHex(address: string): string {
  const C32_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const addr = address.slice(2); // Remove SP/SM/ST prefix
  let num = BigInt(0);
  for (const char of addr) {
    const idx = C32_ALPHABET.indexOf(char.toUpperCase());
    if (idx === -1) continue;
    num = num * 32n + BigInt(idx);
  }
  let hex = num.toString(16);
  while (hex.length < 40) hex = "0" + hex;
  return hex.slice(-40);
}

/**
 * Encode a standard principal as a Clarity argument (hex).
 * Type prefix 0x05 = standard principal, version byte 0x16 = mainnet (22).
 */
function encodePrincipalArg(address: string): string {
  const versionByte = address.startsWith("SP") ? "16" : "1a"; // SP=22, SM=26
  return `0x0516${addressToHex(address)}`;
}

/**
 * Encode a contract principal as a Clarity argument (hex).
 * Type prefix 0x06 = contract principal.
 */
function encodeContractPrincipalArg(contractId: string): string {
  const [addr, name] = contractId.split(".");
  const versionByte = addr.startsWith("SP") ? "16" : "1a";
  const addrHex = addressToHex(addr);
  const nameLen = name.length.toString(16).padStart(2, "0");
  const nameHex = Buffer.from(name).toString("hex");
  return `0x0616${addrHex}${nameLen}${nameHex}`;
}

/**
 * Encode a uint128 as a Clarity argument (hex).
 */
function encodeUintArg(n: number | bigint): string {
  let hex = BigInt(n).toString(16);
  while (hex.length < 32) hex = "0" + hex;
  return `0x01${hex}`;
}

// ─── Wallet & Balance Helpers ───────────────────────────────────────────────

/**
 * Get the AIBTC wallet address from environment.
 */
function getWalletAddress(): string | null {
  return (
    process.env.AIBTC_ADDRESS ||
    process.env.STX_ADDRESS ||
    process.env.WALLET_ADDRESS ||
    null
  );
}

/**
 * Get sBTC balance for an address (in sats) via the balances API.
 */
async function getSbtcBalance(address: string): Promise<number> {
  const url = `${STACKS_API}/extended/v1/address/${address}/balances`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!resp.ok) throw new Error(`Balance API failed: ${resp.status}`);
  const data = (await resp.json()) as any;

  const sbtcKey = Object.keys(data.fungible_tokens || {}).find(
    (k) => k.includes("sbtc-token") || k.includes(SBTC_CONTRACT)
  );

  return sbtcKey ? parseInt(data.fungible_tokens[sbtcKey].balance || "0", 10) : 0;
}

/**
 * Get zsBTC balance for an address (receipt tokens from Zest supply).
 */
async function getZsbtcBalance(address: string): Promise<number> {
  const url = `${STACKS_API}/extended/v1/address/${address}/balances`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!resp.ok) throw new Error(`Balance API failed: ${resp.status}`);
  const data = (await resp.json()) as any;

  const zsbtcKey = Object.keys(data.fungible_tokens || {}).find(
    (k) => k.includes("zsbtc") || k.includes(CONTRACTS.zsbtc)
  );

  return zsbtcKey ? parseInt(data.fungible_tokens[zsbtcKey].balance || "0", 10) : 0;
}

/**
 * Get STX balance for gas check (returns STX, not microSTX).
 */
async function getStxBalance(address: string): Promise<number> {
  const url = `${STACKS_API}/extended/v1/address/${address}/stx`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!resp.ok) throw new Error(`STX balance API failed: ${resp.status}`);
  const data = (await resp.json()) as any;
  return parseInt(data.balance || "0", 10) / 1_000_000;
}

// ─── Zest Protocol Read Helpers ─────────────────────────────────────────────

/**
 * Get Zest reserve state for sBTC.
 * Returns: base-ltv-as-collateral, liquidation-threshold, current-liquidity-rate,
 *          supply-cap, borrow-cap, is-active, etc.
 */
async function getReserveState(): Promise<Record<string, any>> {
  try {
    const cv = await callReadOnly(
      CONTRACTS.poolReserve,
      "get-reserve-state",
      [encodeContractPrincipalArg(SBTC_CONTRACT)]
    );

    if (cv.type === "tuple") {
      const tuple = clarityToTuple(cv);
      const result: Record<string, any> = {};
      for (const [key, val] of Object.entries(tuple)) {
        try {
          if (val.type === "bool") result[key] = val.value;
          else if (val.type === "uint" || val.type === "int") result[key] = Number(val.value);
          else if (val.type === "none") result[key] = null;
          else result[key] = val.value;
        } catch {
          result[key] = val.value;
        }
      }
      return result;
    }

    return { raw: cv };
  } catch (e: any) {
    log("WARN: get-reserve-state failed:", e.message);
    return {};
  }
}

/**
 * Get user reserve data for sBTC position.
 * Returns: principal-borrow-balance, use-as-collateral, etc.
 */
async function getUserReserveData(address: string): Promise<Record<string, any>> {
  try {
    const cv = await callReadOnly(
      CONTRACTS.poolReserve,
      "get-user-reserve-data",
      [
        encodePrincipalArg(address),
        encodeContractPrincipalArg(SBTC_CONTRACT),
      ]
    );

    if (cv.type === "tuple") {
      const tuple = clarityToTuple(cv);
      const result: Record<string, any> = {};
      for (const [key, val] of Object.entries(tuple)) {
        try {
          if (val.type === "bool") result[key] = val.value;
          else if (val.type === "uint" || val.type === "int") result[key] = Number(val.value);
          else if (val.type === "none") result[key] = null;
          else result[key] = val.value;
        } catch {
          result[key] = val.value;
        }
      }
      return result;
    }

    return { raw: cv };
  } catch (e: any) {
    log("WARN: get-user-reserve-data failed:", e.message);
    return {};
  }
}

/**
 * Get pending STX rewards for a user's sBTC supply position.
 */
async function getPendingRewards(address: string): Promise<number> {
  try {
    const cv = await callReadOnly(
      CONTRACTS.incentives,
      "get-vault-rewards",
      [
        encodePrincipalArg(address),
        encodeContractPrincipalArg(SBTC_CONTRACT),
        encodeContractPrincipalArg(STX_CONTRACT),
      ]
    );
    return clarityToNumber(cv);
  } catch (e: any) {
    log("WARN: get-vault-rewards failed:", e.message);
    return 0;
  }
}

/**
 * Build a contract call payload for the AIBTC MCP tool.
 * The MCP tool expects a specific format for submitting transactions.
 */
function buildContractCallArgs(
  contractId: string,
  functionName: string,
  functionArgs: { type: string; value: string }[]
): {
  contractAddress: string;
  contractName: string;
  functionName: string;
  functionArgs: { type: string; value: string }[];
} {
  const [contractAddress, contractName] = contractId.split(".");
  return { contractAddress, contractName, functionName, functionArgs };
}

// ─── Commands ───────────────────────────────────────────────────────────────

/**
 * doctor — check wallet, balances, reserve state, oracle readiness.
 */
async function cmdDoctor(): Promise<void> {
  const warnings: string[] = [];

  // 1. Check wallet
  const address = getWalletAddress();
  if (!address) {
    fail("doctor", "No wallet address found. Set AIBTC_ADDRESS, STX_ADDRESS, or WALLET_ADDRESS.");
    return;
  }
  log("Wallet:", address);

  // 2. Check balances in parallel
  const [stxBalance, sbtcBalance, zsbtcBalance] = await Promise.all([
    getStxBalance(address).catch((e) => {
      warnings.push(`STX balance check failed: ${e.message}`);
      return 0;
    }),
    getSbtcBalance(address).catch((e) => {
      warnings.push(`sBTC balance check failed: ${e.message}`);
      return 0;
    }),
    getZsbtcBalance(address).catch((e) => {
      warnings.push(`zsBTC balance check failed: ${e.message}`);
      return 0;
    }),
  ]);

  const hasGas = stxBalance >= MIN_GAS_STX;
  if (!hasGas) {
    warnings.push(`Low STX for gas: ${stxBalance.toFixed(2)} STX (need ${MIN_GAS_STX} STX)`);
  }

  // 3. Check Zest reserve state
  const reserveState = await getReserveState();
  const isActive = reserveState["is-active"] ?? false;
  const supplyCap = reserveState["supply-cap"] ?? 0;
  const baseLtv = reserveState["base-ltv-as-collateral"] ?? 0;
  const liqThreshold = reserveState["liquidation-threshold"] ?? 0;
  const currentLiquidityRate = reserveState["current-liquidity-rate"] ?? 0;

  if (!isActive) {
    warnings.push("Zest sBTC reserve is NOT active — supply/withdraw operations will fail.");
  }

  // 4. Check oracle
  let oracleStatus = "unknown";
  try {
    await callReadOnly(CONTRACTS.oracle, "get-price");
    oracleStatus = "reachable";
  } catch (e: any) {
    oracleStatus = `error: ${e.message}`;
    warnings.push(`Oracle unreachable: ${e.message}`);
  }

  ok("doctor", {
    wallet: {
      address,
      stxBalance: Math.round(stxBalance * 100) / 100,
      sbtcBalanceSats: sbtcBalance,
      sbtcBalanceBTC: satsToHuman(sbtcBalance),
      zsbtcBalanceSats: zsbtcBalance,
      hasGas,
    },
    reserve: {
      active: isActive,
      supplyCap,
      baseLtvAsCollateral: baseLtv,
      liquidationThreshold: liqThreshold,
      currentLiquidityRate,
    },
    oracle: oracleStatus,
    safetyLimits: {
      maxSupplySats: MAX_SUPPLY_SATS,
      minGasSTX: MIN_GAS_STX,
      minHealthFactor: MIN_HEALTH_FACTOR,
    },
    warnings,
  });
}

/**
 * status — show current position details.
 */
async function cmdStatus(): Promise<void> {
  const address = getWalletAddress();
  if (!address) {
    fail("status", "No wallet address found. Set AIBTC_ADDRESS, STX_ADDRESS, or WALLET_ADDRESS.");
    return;
  }
  log("Wallet:", address);

  // Fetch all data in parallel
  const [zsbtcBalance, sbtcBalance, userReserveData, reserveState, pendingRewards] =
    await Promise.all([
      getZsbtcBalance(address),
      getSbtcBalance(address),
      getUserReserveData(address),
      getReserveState(),
      getPendingRewards(address),
    ]);

  const borrowBalance = userReserveData["principal-borrow-balance"] ?? 0;
  const useAsCollateral = userReserveData["use-as-collateral"] ?? false;
  const baseLtv = reserveState["base-ltv-as-collateral"] ?? 0;
  const liqThreshold = reserveState["liquidation-threshold"] ?? 0;

  // Calculate health factor and LTV
  // Health factor = (collateral * liquidation_threshold) / borrow_balance
  // If no borrows, health factor is effectively infinite
  let healthFactor: number | string = "N/A (no borrows)";
  let ltvPct: number | string = 0;

  if (borrowBalance > 0 && zsbtcBalance > 0) {
    // liqThreshold is in basis points (e.g., 8000 = 80%)
    const hf = (zsbtcBalance * (liqThreshold / 10000)) / borrowBalance;
    healthFactor = Math.round(hf * 100) / 100;

    // Current LTV = borrow / collateral * 100
    ltvPct = Math.round((borrowBalance / zsbtcBalance) * 10000) / 100;
  }

  // Pending rewards in microSTX -> STX
  const pendingRewardsSTX = pendingRewards / 1_000_000;

  ok("status", {
    wallet: address,
    position: {
      suppliedSats: zsbtcBalance,
      suppliedBTC: satsToHuman(zsbtcBalance),
      borrowBalanceSats: borrowBalance,
      borrowBalanceBTC: satsToHuman(borrowBalance),
      useAsCollateral,
      healthFactor,
      ltvPct,
    },
    rewards: {
      pendingRewardsSTX: Math.round(pendingRewardsSTX * 1000000) / 1000000,
      pendingRewardsMicroSTX: pendingRewards,
    },
    reserve: {
      baseLtvAsCollateral: baseLtv,
      liquidationThreshold: liqThreshold,
    },
    availableSbtcSats: sbtcBalance,
    availableSbtcBTC: satsToHuman(sbtcBalance),
  });
}

/**
 * supply — deposit sBTC as collateral to Zest.
 */
async function cmdSupply(amountSats: number): Promise<void> {
  const command = "supply";

  // 1. Validate amount
  if (!Number.isInteger(amountSats) || amountSats <= 0) {
    fail(command, `Amount must be a positive integer (sats). Got: ${amountSats}`);
    return;
  }

  if (amountSats > MAX_SUPPLY_SATS) {
    fail(
      command,
      `Amount ${amountSats} sats exceeds safety limit of ${MAX_SUPPLY_SATS} sats (${satsToHuman(MAX_SUPPLY_SATS)} BTC). ` +
        `This limit is hardcoded and cannot be overridden.`
    );
    return;
  }

  // 2. Check wallet
  const address = getWalletAddress();
  if (!address) {
    fail(command, "No wallet address found. Set AIBTC_ADDRESS, STX_ADDRESS, or WALLET_ADDRESS.");
    return;
  }
  log("Wallet:", address);

  // 3. Pre-flight checks in parallel
  const [stxBalance, sbtcBalance, reserveState] = await Promise.all([
    getStxBalance(address),
    getSbtcBalance(address),
    getReserveState(),
  ]);

  // Check gas
  if (stxBalance < MIN_GAS_STX) {
    fail(
      command,
      `Insufficient STX for gas: have ${stxBalance.toFixed(2)} STX, need ${MIN_GAS_STX} STX.`
    );
    return;
  }

  // Check sBTC balance
  if (sbtcBalance < amountSats) {
    fail(
      command,
      `Insufficient sBTC balance: have ${sbtcBalance} sats, need ${amountSats} sats.`
    );
    return;
  }

  // Check reserve active
  const isActive = reserveState["is-active"] ?? false;
  if (!isActive) {
    fail(command, "Zest sBTC reserve is not active. Cannot supply.");
    return;
  }

  // Check supply cap
  const supplyCap = reserveState["supply-cap"] ?? 0;
  if (supplyCap > 0) {
    // supply-cap is in base units; we'd need total supplied to compare
    // For safety, just warn — the contract will reject if cap exceeded
    log(`Reserve supply cap: ${supplyCap}`);
  }

  // 4. Build and submit transaction
  log(`Supplying ${amountSats} sats (${satsToHuman(amountSats)} BTC) to Zest...`);

  const contractCall = buildContractCallArgs(
    CONTRACTS.borrowHelper,
    "supply",
    [
      { type: "principal", value: CONTRACTS.zsbtc },
      { type: "principal", value: CONTRACTS.poolReserve },
      { type: "principal", value: SBTC_CONTRACT },
      { type: "uint", value: amountSats.toString() },
      { type: "principal", value: address },
      { type: "none", value: "" },
      { type: "principal", value: CONTRACTS.incentives },
    ]
  );

  // Submit via AIBTC MCP
  try {
    const proc = Bun.spawn(
      [
        "npx",
        "@aibtc/mcp-server@latest",
        "contract-call",
        "--contract-address", contractCall.contractAddress,
        "--contract-name", contractCall.contractName,
        "--function-name", contractCall.functionName,
        "--function-args", JSON.stringify(contractCall.functionArgs),
      ],
      { stdout: "pipe", stderr: "pipe" }
    );

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    if (stderr) log("MCP stderr:", stderr);

    let result: any;
    try {
      result = JSON.parse(stdout);
    } catch {
      // If MCP returns a tx hash directly
      result = { txId: stdout.trim() };
    }

    if (result.error) {
      fail(command, `Transaction failed: ${result.error}`);
      return;
    }

    ok(command, {
      txId: result.txId || result.txid || result.tx_id || stdout.trim(),
      amountSats,
      amountBTC: satsToHuman(amountSats),
      contract: CONTRACTS.borrowHelper,
      function: "supply",
      warnings: [],
    });
  } catch (e: any) {
    fail(command, `Failed to submit supply transaction: ${e.message}`);
  }
}

/**
 * withdraw — withdraw sBTC collateral from Zest.
 */
async function cmdWithdraw(amountSats: number): Promise<void> {
  const command = "withdraw";

  // 1. Validate amount
  if (!Number.isInteger(amountSats) || amountSats <= 0) {
    fail(command, `Amount must be a positive integer (sats). Got: ${amountSats}`);
    return;
  }

  // 2. Check wallet
  const address = getWalletAddress();
  if (!address) {
    fail(command, "No wallet address found. Set AIBTC_ADDRESS, STX_ADDRESS, or WALLET_ADDRESS.");
    return;
  }
  log("Wallet:", address);

  // 3. Pre-flight checks
  const [stxBalance, zsbtcBalance, userReserveData, reserveState] = await Promise.all([
    getStxBalance(address),
    getZsbtcBalance(address),
    getUserReserveData(address),
    getReserveState(),
  ]);

  // Check gas
  if (stxBalance < MIN_GAS_STX) {
    fail(
      command,
      `Insufficient STX for gas: have ${stxBalance.toFixed(2)} STX, need ${MIN_GAS_STX} STX.`
    );
    return;
  }

  // Check supplied balance
  if (zsbtcBalance < amountSats) {
    fail(
      command,
      `Insufficient supplied balance: have ${zsbtcBalance} sats supplied, want to withdraw ${amountSats} sats.`
    );
    return;
  }

  // 4. Health factor check — prevent liquidation
  const borrowBalance = userReserveData["principal-borrow-balance"] ?? 0;
  if (borrowBalance > 0) {
    const liqThreshold = reserveState["liquidation-threshold"] ?? 8000;
    const remainingCollateral = zsbtcBalance - amountSats;

    if (remainingCollateral <= 0) {
      fail(
        command,
        `Cannot withdraw all collateral while ${borrowBalance} sats are borrowed. Repay debt first.`
      );
      return;
    }

    // Projected health factor after withdrawal
    const projectedHF =
      (remainingCollateral * (liqThreshold / 10000)) / borrowBalance;

    if (projectedHF < MIN_HEALTH_FACTOR) {
      fail(
        command,
        `Withdrawal would drop health factor to ${projectedHF.toFixed(2)} (minimum: ${MIN_HEALTH_FACTOR}). ` +
          `Reduce withdrawal amount or repay debt first. ` +
          `Current supplied: ${zsbtcBalance} sats, borrowed: ${borrowBalance} sats.`
      );
      return;
    }

    log(`Projected health factor after withdrawal: ${projectedHF.toFixed(2)}`);
  }

  // 5. Build and submit transaction
  log(`Withdrawing ${amountSats} sats (${satsToHuman(amountSats)} BTC) from Zest...`);

  const contractCall = buildContractCallArgs(
    CONTRACTS.borrowHelper,
    "withdraw",
    [
      { type: "principal", value: CONTRACTS.zsbtc },
      { type: "principal", value: CONTRACTS.poolReserve },
      { type: "principal", value: SBTC_CONTRACT },
      { type: "principal", value: CONTRACTS.oracle },
      { type: "uint", value: amountSats.toString() },
      { type: "principal", value: address },
      { type: "list", value: JSON.stringify([SBTC_CONTRACT]) },
      { type: "principal", value: CONTRACTS.incentives },
      { type: "buff", value: "0x00" },
    ]
  );

  try {
    const proc = Bun.spawn(
      [
        "npx",
        "@aibtc/mcp-server@latest",
        "contract-call",
        "--contract-address", contractCall.contractAddress,
        "--contract-name", contractCall.contractName,
        "--function-name", contractCall.functionName,
        "--function-args", JSON.stringify(contractCall.functionArgs),
      ],
      { stdout: "pipe", stderr: "pipe" }
    );

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    if (stderr) log("MCP stderr:", stderr);

    let result: any;
    try {
      result = JSON.parse(stdout);
    } catch {
      result = { txId: stdout.trim() };
    }

    if (result.error) {
      fail(command, `Transaction failed: ${result.error}`);
      return;
    }

    ok(command, {
      txId: result.txId || result.txid || result.tx_id || stdout.trim(),
      amountSats,
      amountBTC: satsToHuman(amountSats),
      contract: CONTRACTS.borrowHelper,
      function: "withdraw",
      remainingSuppliedSats: zsbtcBalance - amountSats,
      warnings: [],
    });
  } catch (e: any) {
    fail(command, `Failed to submit withdraw transaction: ${e.message}`);
  }
}

/**
 * claim-rewards — claim pending STX stacking rewards.
 */
async function cmdClaimRewards(): Promise<void> {
  const command = "claim-rewards";

  // 1. Check wallet
  const address = getWalletAddress();
  if (!address) {
    fail(command, "No wallet address found. Set AIBTC_ADDRESS, STX_ADDRESS, or WALLET_ADDRESS.");
    return;
  }
  log("Wallet:", address);

  // 2. Check gas and rewards in parallel
  const [stxBalance, pendingRewards] = await Promise.all([
    getStxBalance(address),
    getPendingRewards(address),
  ]);

  if (stxBalance < MIN_GAS_STX) {
    fail(
      command,
      `Insufficient STX for gas: have ${stxBalance.toFixed(2)} STX, need ${MIN_GAS_STX} STX.`
    );
    return;
  }

  if (pendingRewards <= 0) {
    fail(command, "No pending rewards to claim.");
    return;
  }

  const pendingRewardsSTX = pendingRewards / 1_000_000;
  log(`Claiming ${pendingRewardsSTX.toFixed(6)} STX in rewards...`);

  // 3. Build and submit claim transaction
  const contractCall = buildContractCallArgs(
    CONTRACTS.borrowHelper,
    "claim-rewards",
    [
      { type: "principal", value: CONTRACTS.zsbtc },
      { type: "principal", value: CONTRACTS.poolReserve },
      { type: "principal", value: SBTC_CONTRACT },
      { type: "principal", value: CONTRACTS.oracle },
      { type: "principal", value: address },
      { type: "list", value: JSON.stringify([SBTC_CONTRACT]) },
      { type: "principal", value: STX_CONTRACT },
      { type: "principal", value: CONTRACTS.incentives },
      { type: "buff", value: "0x00" },
    ]
  );

  try {
    const proc = Bun.spawn(
      [
        "npx",
        "@aibtc/mcp-server@latest",
        "contract-call",
        "--contract-address", contractCall.contractAddress,
        "--contract-name", contractCall.contractName,
        "--function-name", contractCall.functionName,
        "--function-args", JSON.stringify(contractCall.functionArgs),
      ],
      { stdout: "pipe", stderr: "pipe" }
    );

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    if (stderr) log("MCP stderr:", stderr);

    let result: any;
    try {
      result = JSON.parse(stdout);
    } catch {
      result = { txId: stdout.trim() };
    }

    if (result.error) {
      fail(command, `Transaction failed: ${result.error}`);
      return;
    }

    ok(command, {
      txId: result.txId || result.txid || result.tx_id || stdout.trim(),
      claimedRewardsMicroSTX: pendingRewards,
      claimedRewardsSTX: Math.round(pendingRewardsSTX * 1000000) / 1000000,
      contract: CONTRACTS.borrowHelper,
      function: "claim-rewards",
      warnings: [],
    });
  } catch (e: any) {
    fail(command, `Failed to submit claim-rewards transaction: ${e.message}`);
  }
}

// ─── CLI Entry Point (Commander.js) ──────────────────────────────────────────

const program = new Command();

program
  .name("zest-collateral-manager")
  .description(
    "Autonomous sBTC collateral manager for Zest Protocol — supply, withdraw, monitor health factor, and claim STX rewards."
  )
  .version("1.0.0");

program
  .command("doctor")
  .description("Check wallet, balances, reserve state, and oracle readiness")
  .action(async () => {
    try {
      await cmdDoctor();
    } catch (e: any) {
      fail("doctor", e.message);
    }
  });

program
  .command("status")
  .description("Show current position: supplied, borrowed, health factor, rewards")
  .action(async () => {
    try {
      await cmdStatus();
    } catch (e: any) {
      fail("status", e.message);
    }
  });

program
  .command("supply")
  .description(`Supply sBTC as collateral (max ${MAX_SUPPLY_SATS} sats per tx)`)
  .requiredOption("--amount <sats>", "Amount of sBTC to supply in satoshis", parseInt)
  .action(async (opts) => {
    try {
      await cmdSupply(opts.amount);
    } catch (e: any) {
      fail("supply", e.message);
    }
  });

program
  .command("withdraw")
  .description("Withdraw sBTC collateral (health factor safe)")
  .requiredOption("--amount <sats>", "Amount of sBTC to withdraw in satoshis", parseInt)
  .action(async (opts) => {
    try {
      await cmdWithdraw(opts.amount);
    } catch (e: any) {
      fail("withdraw", e.message);
    }
  });

program
  .command("claim-rewards")
  .description("Claim pending STX stacking rewards")
  .action(async () => {
    try {
      await cmdClaimRewards();
    } catch (e: any) {
      fail("claim-rewards", e.message);
    }
  });

program.parse();
