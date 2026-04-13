#!/usr/bin/env bun
/**
 * hermetica-hbtc-yield — Autonomous sBTC yield manager for Hermetica hBTC vault
 *
 * Deposits sBTC into Hermetica's hBTC vault to earn Bitcoin-denominated yield (~6% APY).
 * Monitors position value, share price, and vault state.
 * Handles two-step redemption flow (request-redeem -> cooldown -> redeem).
 *
 * Commands:
 *   doctor          — check wallet, balances, vault state
 *   status          — current position, APY, vault state
 *   deposit         — deposit sBTC into hBTC vault
 *   request-redeem  — request withdrawal (initiates cooldown)
 *   redeem          — collect sBTC after cooldown
 *
 * All commands output strict JSON to stdout.
 * Diagnostic logs go to stderr.
 */

import { Command } from "commander";

// ─── Constants ───────────────────────────────────────────────────────────────

/** Hermetica contract deployer */
const DEPLOYER = "SP1S1HSFH0SQQGWKB69EYFNY0B1MHRMGXR3J1FH4D";

/** Hermetica hBTC contracts */
const CONTRACTS = {
  vault: `${DEPLOYER}.vault-hbtc-v1`,
  token: `${DEPLOYER}.token-hbtc`,
  state: `${DEPLOYER}.state-hbtc-v1`,
  reserve: `${DEPLOYER}.reserve-hbtc-v1`,
} as const;

/** sBTC token contract */
const SBTC_CONTRACT = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";

/** Hermetica REST API host (env-overridable for testing/private gateways) */
const HERMETICA_API_HOST = process.env.HERMETICA_API_HOST || "https://app.hermetica.fi";

/** Hermetica REST API endpoints */
const API = {
  hbtcRate: `${HERMETICA_API_HOST}/api/v2c/info/hbtc_rate`,
  hbtcApy: `${HERMETICA_API_HOST}/api/v2/info/apy/hbtc?range=7d`,
} as const;

/** Stacks API for read-only calls (env-overridable) */
const STACKS_API = process.env.READONLY_CALL_API_HOST || "https://api.hiro.so";
const HIRO_API_KEY = process.env.HIRO_API_KEY || process.env.READONLY_CALL_API_KEY || "";
const hiroHeaders: Record<string, string> = { Accept: "application/json" };
if (HIRO_API_KEY) hiroHeaders["x-api-key"] = HIRO_API_KEY;

/** hBTC and sBTC both use 8 decimal places */
const DECIMALS = 8;

/**
 * SAFETY LIMIT: Maximum deposit per transaction in sats.
 * Hardcoded — cannot be overridden by CLI args or environment.
 * 50,000 sats = 0.0005 BTC.
 */
const MAX_DEPOSIT_SATS = 50_000;

/** Minimum STX balance required for gas (conservative estimate for contract calls) */
const MIN_GAS_STX = 0.5;

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
  console.error("[hermetica-hbtc]", ...args);
}

function satsToHuman(sats: number): string {
  return (sats / 10 ** DECIMALS).toFixed(DECIMALS);
}

function humanToSats(human: number): number {
  return Math.round(human * 10 ** DECIMALS);
}

// ─── Stacks read-only call helpers ───────────────────────────────────────────

interface ClarityValue {
  type: string;
  value: any;
  repr?: string;
}

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
    headers: { ...hiroHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({
      sender: senderAddress,
      arguments: args,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Read-only call ${name}.${fn} failed (${resp.status}): ${text}`);
  }

  const result = await resp.json() as any;

  if (!result.okay || result.okay === "false") {
    throw new Error(`Read-only call ${name}.${fn} returned not-okay: ${result.cause || JSON.stringify(result)}`);
  }

  return result.result ? parseClarityValue(result.result) : { type: "none", value: null };
}

/**
 * Parse a Clarity hex value or repr into a usable JS value.
 * Handles common types: uint, int, bool, optional, tuple.
 */
function parseClarityValue(raw: any): ClarityValue {
  // If it's already parsed (from some API responses)
  if (typeof raw === "object" && raw.type) return raw;

  // The Hiro API returns hex-encoded Clarity values
  // We'll use the repr string if available, or parse the hex
  if (typeof raw === "string") {
    // Try to parse repr-style: (ok u1234), u1234, true, false, none, (some u1234)
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

    // Hex-encoded Clarity value — extract uint if it starts with 0x01 (uint type prefix)
    if (repr.startsWith("0x")) {
      const hex = repr.slice(2);
      // Clarity type byte: 0x01 = int128, 0x03 = bool true, 0x04 = bool false
      // 0x01 followed by 16 bytes = uint128
      if (hex.length >= 34 && hex.startsWith("01")) {
        const numHex = hex.slice(2, 34);
        return { type: "uint", value: BigInt("0x" + numHex), repr };
      }
      // 0x07 = ok response, next byte is inner type
      if (hex.startsWith("07")) {
        return parseClarityValue("0x" + hex.slice(2));
      }
      // 0x09 = none
      if (hex === "09") return { type: "none", value: null, repr };
      // 0x0a = some, rest is inner value
      if (hex.startsWith("0a")) {
        return { type: "optional", value: parseClarityValue("0x" + hex.slice(2)), repr };
      }
      // 0x03 = true, 0x04 = false
      if (hex === "03") return { type: "bool", value: true, repr };
      if (hex === "04") return { type: "bool", value: false, repr };
    }

    return { type: "unknown", value: repr, repr };
  }

  return { type: "unknown", value: raw };
}

/**
 * Extract a numeric value from a Clarity result, returning as number.
 */
function clarityToNumber(cv: ClarityValue): number {
  if (cv.type === "uint" || cv.type === "int") {
    return Number(cv.value);
  }
  if (cv.type === "optional" && cv.value) {
    return clarityToNumber(cv.value);
  }
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

// ─── AIBTC MCP Tool Helpers ──────────────────────────────────────────────────

/**
 * Get the AIBTC wallet address.
 * Uses the MCP wallet tool via environment or falls back to env var.
 */
async function getWalletAddress(): Promise<string | null> {
  // Try AIBTC MCP environment
  const addr = process.env.AIBTC_ADDRESS || process.env.STX_ADDRESS || process.env.WALLET_ADDRESS;
  if (addr) return addr;

  // Try calling MCP get-wallet-address
  try {
    const proc = Bun.spawn(["npx", "@aibtc/mcp-server@latest", "get-wallet-status"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const text = await new Response(proc.stdout).text();
    const parsed = JSON.parse(text);
    return parsed.address || parsed.stxAddress || null;
  } catch {
    return null;
  }
}

/**
 * Get sBTC balance for an address (in sats).
 * Uses the Hiro token-holdings API which doesn't require c32-encoded arguments.
 */
async function getSbtcBalance(address: string): Promise<number> {
  const url = `${STACKS_API}/extended/v1/address/${address}/balances`;
  const resp = await fetch(url, { headers: hiroHeaders });
  if (!resp.ok) throw new Error(`Balance API failed: ${resp.status}`);
  const data = await resp.json() as any;

  // Look for sBTC in fungible tokens
  const sbtcKey = Object.keys(data.fungible_tokens || {}).find(
    (k) => k.includes("sbtc-token") || k.includes(SBTC_CONTRACT)
  );

  if (sbtcKey) {
    return parseInt(data.fungible_tokens[sbtcKey].balance || "0", 10);
  }
  return 0;
}

/**
 * Get hBTC balance for an address (in base units).
 */
async function getHbtcBalance(address: string): Promise<number> {
  try {
    const url = `${STACKS_API}/extended/v1/address/${address}/balances`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Balance API failed: ${resp.status}`);
    const data = await resp.json() as any;

    const hbtcKey = Object.keys(data.fungible_tokens || {}).find(
      (k) => k.includes("token-hbtc") || k.includes(CONTRACTS.token)
    );

    if (hbtcKey) {
      return parseInt(data.fungible_tokens[hbtcKey].balance || "0", 10);
    }
    return 0;
  } catch (e: any) {
    log(`getHbtcBalance failed for ${address}: ${e?.message || e}`);
    return 0;
  }
}

/**
 * Get STX balance for gas check.
 */
async function getStxBalance(address: string): Promise<number> {
  const url = `${STACKS_API}/extended/v1/address/${address}/stx`;
  const resp = await fetch(url, { headers: hiroHeaders });
  if (!resp.ok) throw new Error(`STX balance API failed: ${resp.status}`);
  const data = await resp.json() as any;
  return parseInt(data.balance || "0", 10) / 1_000_000; // Convert uSTX to STX
}

// ─── Hermetica API Helpers ───────────────────────────────────────────────────

interface HbtcRate {
  rate: number;
}

interface HbtcApy {
  apy: string;
  last_update: number;
}

/**
 * Fetch hBTC share price from Hermetica API.
 */
async function fetchHbtcRate(): Promise<number> {
  try {
    const resp = await fetch(API.hbtcRate, { signal: AbortSignal.timeout(10_000) });
    if (!resp.ok) throw new Error(`API ${resp.status}`);
    const data = (await resp.json()) as HbtcRate;
    return data.rate;
  } catch (e: any) {
    log("WARN: hBTC rate API failed, falling back to on-chain:", e.message);
    return await fetchSharePriceOnChain();
  }
}

/**
 * Fetch hBTC APY from Hermetica API.
 */
async function fetchHbtcApy(): Promise<{ apyPct: number; lastUpdate: number } | null> {
  try {
    const resp = await fetch(API.hbtcApy, { signal: AbortSignal.timeout(10_000) });
    if (!resp.ok) throw new Error(`API ${resp.status}`);
    const data = (await resp.json()) as HbtcApy;
    return {
      apyPct: parseFloat(data.apy),
      lastUpdate: data.last_update,
    };
  } catch (e: any) {
    log("WARN: hBTC APY API failed:", e.message);
    return null;
  }
}

/**
 * Get share price from on-chain state contract.
 */
async function fetchSharePriceOnChain(): Promise<number> {
  try {
    const cv = await callReadOnly(CONTRACTS.state, "get-share-price");
    const raw = clarityToNumber(cv);
    // Share price is in 8-decimal fixed point
    return raw / 10 ** DECIMALS;
  } catch (e: any) {
    log("WARN: On-chain share price failed:", e.message);
    return 1.0; // Safe fallback
  }
}

/**
 * Check if deposits are enabled.
 */
async function isDepositEnabled(): Promise<boolean> {
  try {
    const cv = await callReadOnly(CONTRACTS.state, "get-deposit-enabled");
    return clarityToBool(cv);
  } catch (e: any) {
    log("WARN: deposit-enabled check failed:", e.message);
    return false; // Fail safe
  }
}

/**
 * Get total vault assets.
 */
async function getTotalAssets(): Promise<number> {
  try {
    const cv = await callReadOnly(CONTRACTS.state, "get-total-assets");
    return clarityToNumber(cv);
  } catch (e: any) {
    log("WARN: get-total-assets failed:", e.message);
    return 0;
  }
}

/**
 * Get deposit cap.
 */
async function getDepositCap(): Promise<number> {
  try {
    const cv = await callReadOnly(CONTRACTS.state, "get-deposit-cap");
    return clarityToNumber(cv);
  } catch (e: any) {
    log("WARN: get-deposit-cap failed:", e.message);
    return 0;
  }
}

/**
 * Preview deposit: how many hBTC shares for a given sBTC amount.
 */
async function previewDeposit(amountSats: number): Promise<number> {
  try {
    // Encode uint as Clarity hex: type byte 01 + 16-byte big-endian
    const hexAmount = amountSats.toString(16).padStart(32, "0");
    const cv = await callReadOnly(CONTRACTS.vault, "preview-deposit", [`0x01${hexAmount}`]);
    return clarityToNumber(cv);
  } catch (e: any) {
    log("WARN: preview-deposit failed, estimating from rate:", e.message);
    const rate = await fetchHbtcRate();
    return Math.floor(amountSats / rate);
  }
}

/**
 * Preview redeem: how much sBTC for a given hBTC share amount.
 */
async function previewRedeem(shares: number): Promise<number> {
  try {
    const hexShares = shares.toString(16).padStart(32, "0");
    const cv = await callReadOnly(CONTRACTS.vault, "preview-redeem", [`0x01${hexShares}`]);
    return clarityToNumber(cv);
  } catch (e: any) {
    log("WARN: preview-redeem failed, estimating from rate:", e.message);
    const rate = await fetchHbtcRate();
    return Math.floor(shares * rate);
  }
}

// ─── Commands ────────────────────────────────────────────────────────────────

/**
 * doctor — Check environment, wallet, balances, vault state.
 */
async function cmdDoctor(): Promise<void> {
  const warnings: string[] = [];
  const checks: Record<string, any> = {};

  // 1. Wallet check
  const walletAddr = await getWalletAddress();
  checks.walletReady = !!walletAddr;
  checks.walletAddress = walletAddr || null;
  if (!walletAddr) {
    warnings.push("No wallet address found. Set AIBTC_ADDRESS, STX_ADDRESS, or install @aibtc/mcp-server.");
  }

  // 2. STX gas balance
  if (walletAddr) {
    try {
      const stxBal = await getStxBalance(walletAddr);
      checks.stxBalanceSTX = Math.round(stxBal * 1000) / 1000;
      checks.gasReady = stxBal >= MIN_GAS_STX;
      if (!checks.gasReady) {
        warnings.push(`Insufficient STX for gas: have ${stxBal.toFixed(3)} STX, need ${MIN_GAS_STX} STX minimum.`);
      }
    } catch (e: any) {
      checks.stxBalanceSTX = null;
      checks.gasReady = false;
      warnings.push(`STX balance check failed: ${e.message}`);
    }
  }

  // 3. sBTC balance
  if (walletAddr) {
    try {
      const sbtcBal = await getSbtcBalance(walletAddr);
      checks.sbtcBalanceSats = sbtcBal;
      checks.sbtcBalanceBTC = satsToHuman(sbtcBal);
    } catch (e: any) {
      checks.sbtcBalanceSats = null;
      warnings.push(`sBTC balance check failed: ${e.message}`);
    }
  }

  // 4. hBTC balance
  if (walletAddr) {
    try {
      const hbtcBal = await getHbtcBalance(walletAddr);
      checks.hbtcBalanceShares = hbtcBal;
    } catch (e: any) {
      checks.hbtcBalanceShares = null;
      warnings.push(`hBTC balance check failed: ${e.message}`);
    }
  }

  // 5. Vault state
  try {
    const depositEnabled = await isDepositEnabled();
    checks.depositEnabled = depositEnabled;
    if (!depositEnabled) {
      warnings.push("Vault deposits are currently disabled.");
    }
  } catch (e: any) {
    checks.depositEnabled = null;
    warnings.push(`Deposit-enabled check failed: ${e.message}`);
  }

  // 6. Share price
  try {
    const rate = await fetchHbtcRate();
    checks.sharePrice = rate;
  } catch (e: any) {
    checks.sharePrice = null;
    warnings.push(`Share price fetch failed: ${e.message}`);
  }

  // 7. Hermetica API health
  try {
    const apy = await fetchHbtcApy();
    checks.apiReachable = !!apy;
    if (apy) {
      checks.apyPct = Math.round(apy.apyPct * 100) / 100;
    } else {
      warnings.push("Hermetica API returned no APY data.");
    }
  } catch (e: any) {
    checks.apiReachable = false;
    warnings.push(`Hermetica API unreachable: ${e?.message || e}`);
  }

  // 8. Surface env config
  checks.config = {
    stacksApiHost: STACKS_API,
    hermeticaApiHost: HERMETICA_API_HOST,
    hiroApiKeyConfigured: Boolean(HIRO_API_KEY),
  };
  if (!HIRO_API_KEY) {
    warnings.push(
      "HIRO_API_KEY not set. Doctor + status issue ~6-8 Hiro reads each; without a key, public rate limits may cause partial degradation."
    );
  }

  checks.maxDepositSats = MAX_DEPOSIT_SATS;
  checks.warnings = warnings;

  // Health summary: count blocking vs informational warnings so consumers can
  // distinguish "wallet/gas/balance failure" (blocking) from "no HIRO_API_KEY"
  // (informational, public limits still work).
  const informationalPrefixes = ["HIRO_API_KEY not set"];
  const blockingWarnings = warnings.filter(
    (w) => !informationalPrefixes.some((p) => w.startsWith(p))
  );
  checks.health = {
    blocking: blockingWarnings.length,
    informational: warnings.length - blockingWarnings.length,
    state: blockingWarnings.length === 0 ? "healthy" : "degraded",
  };

  ok("doctor", checks);
}

/**
 * status — Show current position, APY, value, vault state.
 */
async function cmdStatus(): Promise<void> {
  const warnings: string[] = [];

  const walletAddr = await getWalletAddress();
  if (!walletAddr) {
    return fail("status", "No wallet address found. Run doctor for details.");
  }

  // Fetch all data in parallel
  const [hbtcBal, sbtcBal, rate, apy, totalAssets, depositCap, depositEnabled] = await Promise.all([
    getHbtcBalance(walletAddr),
    getSbtcBalance(walletAddr),
    fetchHbtcRate(),
    fetchHbtcApy(),
    getTotalAssets(),
    getDepositCap(),
    isDepositEnabled(),
  ]);

  // Calculate position value
  const positionValueSats = Math.floor(hbtcBal * rate);
  // Approximation: assumes all shares were minted at a 1:1 rate.
  // Actual yield depends on the share price at each deposit time, which
  // we don't track. This is a best-effort estimate for display purposes.
  const yieldEarnedSats = positionValueSats - hbtcBal;

  // APY data
  let apyPct: number | null = null;
  if (apy) {
    apyPct = Math.round(apy.apyPct * 100) / 100;
  } else {
    warnings.push("APY data unavailable from Hermetica API; displaying on-chain share price only.");
  }

  // Vault capacity
  const vaultUtilizationPct = depositCap > 0
    ? Math.round((totalAssets / depositCap) * 10000) / 100
    : null;

  const data = {
    walletAddress: walletAddr,
    hbtcBalanceShares: hbtcBal,
    hbtcBalanceBTC: satsToHuman(hbtcBal),
    sharePrice: rate,
    positionValueSats,
    positionValueBTC: satsToHuman(positionValueSats),
    yieldEarnedSats: yieldEarnedSats > 0 ? yieldEarnedSats : 0,
    yieldEarnedBTC: yieldEarnedSats > 0 ? satsToHuman(yieldEarnedSats) : "0.00000000",
    sbtcBalanceSats: sbtcBal,
    sbtcBalanceBTC: satsToHuman(sbtcBal),
    apyPct,
    apySource: apy ? "hermetica-api-7d" : null,
    vaultTotalAssetsSats: totalAssets,
    vaultDepositCapSats: depositCap,
    vaultUtilizationPct,
    depositEnabled,
    maxDepositSats: MAX_DEPOSIT_SATS,
    warnings,
  };

  ok("status", data);
}

/**
 * deposit — Deposit sBTC into the hBTC vault.
 */
async function cmdDeposit(amountSatsRaw: string): Promise<void> {
  const warnings: string[] = [];
  const amountSats = parseInt(amountSatsRaw, 10);

  // ── Validate amount ──
  if (isNaN(amountSats) || amountSats <= 0) {
    return fail("deposit", `Invalid amount: ${amountSatsRaw}. Must be a positive integer (sats).`);
  }

  // ── SAFETY LIMIT: enforce max deposit ──
  if (amountSats > MAX_DEPOSIT_SATS) {
    return fail(
      "deposit",
      `Amount ${amountSats} sats exceeds hardcoded safety limit of ${MAX_DEPOSIT_SATS} sats (${satsToHuman(MAX_DEPOSIT_SATS)} BTC). Reduce amount and retry.`
    );
  }

  // ── Wallet check ──
  const walletAddr = await getWalletAddress();
  if (!walletAddr) {
    return fail("deposit", "No wallet address found. Run doctor for setup instructions.");
  }

  // ── Pre-flight checks (parallel) ──
  const [sbtcBal, stxBal, depositEnabled, sharePrice] = await Promise.all([
    getSbtcBalance(walletAddr),
    getStxBalance(walletAddr),
    isDepositEnabled(),
    fetchHbtcRate(),
  ]);

  // Check deposit enabled
  if (!depositEnabled) {
    return fail("deposit", "Vault deposits are currently disabled. Try again later.", { depositEnabled: false });
  }

  // Check sBTC balance
  if (sbtcBal < amountSats) {
    return fail(
      "deposit",
      `Insufficient sBTC balance: have ${sbtcBal} sats, need ${amountSats} sats.`,
      { sbtcBalanceSats: sbtcBal, requestedSats: amountSats }
    );
  }

  // Check gas
  if (stxBal < MIN_GAS_STX) {
    return fail(
      "deposit",
      `Insufficient STX for gas: have ${stxBal.toFixed(3)} STX, need ${MIN_GAS_STX} STX.`,
      { stxBalanceSTX: stxBal, minGasSTX: MIN_GAS_STX }
    );
  }

  // Check vault capacity
  try {
    const [totalAssets, depositCap] = await Promise.all([getTotalAssets(), getDepositCap()]);
    if (depositCap > 0 && totalAssets + amountSats > depositCap) {
      const remaining = depositCap - totalAssets;
      return fail(
        "deposit",
        `Vault deposit cap would be exceeded. Remaining capacity: ${remaining} sats.`,
        { vaultCapSats: depositCap, totalAssetsSats: totalAssets, remainingCapSats: remaining }
      );
    }
  } catch (e: any) {
    warnings.push(`Could not verify vault capacity: ${e.message}`);
  }

  // Estimate shares
  let expectedShares: number;
  try {
    expectedShares = await previewDeposit(amountSats);
  } catch {
    expectedShares = Math.floor(amountSats / sharePrice);
    warnings.push("Used estimated share calculation (preview-deposit unavailable).");
  }

  // ── Build and submit transaction ──
  // The deposit function signature: (deposit (assets uint) (affiliate (optional (buff 64))))
  // Using AIBTC MCP tools to build and broadcast the transaction
  log(`Depositing ${amountSats} sats into hBTC vault...`);

  try {
    const contractCall = {
      contractAddress: DEPLOYER,
      contractName: "vault-hbtc-v1",
      functionName: "deposit",
      functionArgs: [
        { type: "uint128", value: amountSats.toString() },
        { type: "none" }, // no affiliate
      ],
      postConditions: [
        {
          type: "ft-postcondition",
          address: walletAddr,
          conditionCode: "eq",
          amount: amountSats.toString(),
          asset: SBTC_CONTRACT + "::sbtc",
        },
      ],
    };

    // Output the MCP command for the agent to execute
    ok("deposit", {
      action: "execute-contract-call",
      contractCall,
      humanReadable: {
        description: `Deposit ${amountSats} sats (${satsToHuman(amountSats)} BTC) into Hermetica hBTC vault`,
        contract: CONTRACTS.vault,
        function: "deposit",
        amountSats,
        amountBTC: satsToHuman(amountSats),
        expectedSharesHBTC: expectedShares,
        sharePrice,
        maxDepositSats: MAX_DEPOSIT_SATS,
      },
      mcpCommand: {
        tool: "contract-call",
        args: {
          contract: CONTRACTS.vault,
          function: "deposit",
          arguments: [`u${amountSats}`, "none"],
        },
      },
      warnings,
    });
  } catch (e: any) {
    fail("deposit", `Transaction construction failed: ${e.message}`, { amountSats });
  }
}

/**
 * request-redeem — Request withdrawal from hBTC vault with cooldown.
 */
async function cmdRequestRedeem(sharesRaw: string, isExpress: boolean): Promise<void> {
  const warnings: string[] = [];
  const shares = parseInt(sharesRaw, 10);

  // ── Validate shares ──
  if (isNaN(shares) || shares <= 0) {
    return fail("request-redeem", `Invalid shares amount: ${sharesRaw}. Must be a positive integer.`);
  }

  // ── Wallet check ──
  const walletAddr = await getWalletAddress();
  if (!walletAddr) {
    return fail("request-redeem", "No wallet address found. Run doctor for setup instructions.");
  }

  // ── Pre-flight checks ──
  const [hbtcBal, stxBal, sharePrice] = await Promise.all([
    getHbtcBalance(walletAddr),
    getStxBalance(walletAddr),
    fetchHbtcRate(),
  ]);

  // Check hBTC balance
  if (hbtcBal < shares) {
    return fail(
      "request-redeem",
      `Insufficient hBTC balance: have ${hbtcBal} shares, need ${shares} shares.`,
      { hbtcBalanceShares: hbtcBal, requestedShares: shares }
    );
  }

  // Check gas
  if (stxBal < MIN_GAS_STX) {
    return fail(
      "request-redeem",
      `Insufficient STX for gas: have ${stxBal.toFixed(3)} STX, need ${MIN_GAS_STX} STX.`,
      { stxBalanceSTX: stxBal, minGasSTX: MIN_GAS_STX }
    );
  }

  // Estimate sBTC return
  let expectedSbtc: number;
  try {
    expectedSbtc = await previewRedeem(shares);
  } catch {
    expectedSbtc = Math.floor(shares * sharePrice);
    warnings.push("Used estimated redemption calculation (preview-redeem unavailable).");
  }

  // ── Build transaction ──
  // request-redeem(shares uint, is-express bool)
  log(`Requesting redemption of ${shares} hBTC shares (express: ${isExpress})...`);

  try {
    const contractCall = {
      contractAddress: DEPLOYER,
      contractName: "vault-hbtc-v1",
      functionName: "request-redeem",
      functionArgs: [
        { type: "uint128", value: shares.toString() },
        { type: "bool", value: isExpress },
      ],
      postConditions: [
        {
          type: "ft-postcondition",
          address: walletAddr,
          conditionCode: "eq",
          amount: shares.toString(),
          asset: CONTRACTS.token + "::token-hbtc",
        },
      ],
    };

    ok("request-redeem", {
      action: "execute-contract-call",
      contractCall,
      humanReadable: {
        description: `Request redemption of ${shares} hBTC shares${isExpress ? " (EXPRESS)" : ""}`,
        contract: CONTRACTS.vault,
        function: "request-redeem",
        shares,
        isExpress,
        expectedSbtcSats: expectedSbtc,
        expectedSbtcBTC: satsToHuman(expectedSbtc),
        sharePrice,
        note: isExpress
          ? "Express redemption — faster but may have higher cost."
          : "Standard redemption — cooldown period applies. Use 'status' to check when redeem is available.",
      },
      mcpCommand: {
        tool: "contract-call",
        args: {
          contract: CONTRACTS.vault,
          function: "request-redeem",
          arguments: [`u${shares}`, isExpress.toString()],
        },
      },
      warnings,
    });
  } catch (e: any) {
    fail("request-redeem", `Transaction construction failed: ${e.message}`, { shares });
  }
}

/**
 * redeem — Collect sBTC after cooldown has expired.
 */
async function cmdRedeem(claimIdRaw: string): Promise<void> {
  const warnings: string[] = [];
  const claimId = parseInt(claimIdRaw, 10);

  // ── Validate claim ID ──
  if (isNaN(claimId) || claimId < 0) {
    return fail("redeem", `Invalid claim ID: ${claimIdRaw}. Must be a non-negative integer.`);
  }

  // ── Wallet check ──
  const walletAddr = await getWalletAddress();
  if (!walletAddr) {
    return fail("redeem", "No wallet address found. Run doctor for setup instructions.");
  }

  // ── Gas check ──
  const stxBal = await getStxBalance(walletAddr);
  if (stxBal < MIN_GAS_STX) {
    return fail(
      "redeem",
      `Insufficient STX for gas: have ${stxBal.toFixed(3)} STX, need ${MIN_GAS_STX} STX.`,
      { stxBalanceSTX: stxBal, minGasSTX: MIN_GAS_STX }
    );
  }

  // ── Build transaction ──
  // redeem(claim-id uint)
  log(`Redeeming claim ID ${claimId}...`);

  try {
    const contractCall = {
      contractAddress: DEPLOYER,
      contractName: "vault-hbtc-v1",
      functionName: "redeem",
      functionArgs: [
        { type: "uint128", value: claimId.toString() },
      ],
      postConditions: [],
    };

    ok("redeem", {
      action: "execute-contract-call",
      contractCall,
      humanReadable: {
        description: `Redeem claim ID ${claimId} to collect sBTC from hBTC vault`,
        contract: CONTRACTS.vault,
        function: "redeem",
        claimId,
        note: "Ensure cooldown period has expired before calling. If cooldown is still active, the transaction will fail.",
      },
      mcpCommand: {
        tool: "contract-call",
        args: {
          contract: CONTRACTS.vault,
          function: "redeem",
          arguments: [`u${claimId}`],
        },
      },
      warnings,
    });
  } catch (e: any) {
    fail("redeem", `Transaction construction failed: ${e.message}`, { claimId });
  }
}

// ─── CLI Entry Point (Commander.js) ──────────────────────────────────────────

const program = new Command();

program
  .name("hermetica-hbtc-yield")
  .description(
    "Autonomous sBTC yield manager for Hermetica hBTC vault on Stacks. " +
    "Deposit sBTC to earn ~6% APY via Bitcoin-backed vault shares."
  )
  .version("1.0.0");

program
  .command("doctor")
  .description("Check wallet, balances, vault state, and API connectivity")
  .action(async () => {
    try {
      await cmdDoctor();
    } catch (e: any) {
      fail("doctor", e.message);
    }
  });

program
  .command("status")
  .description("Show current hBTC position, share price, APY, and vault state")
  .action(async () => {
    try {
      await cmdStatus();
    } catch (e: any) {
      fail("status", e.message);
    }
  });

program
  .command("deposit")
  .description(`Deposit sBTC into hBTC vault (max ${MAX_DEPOSIT_SATS} sats per tx)`)
  .requiredOption("--amount <sats>", "Amount of sBTC to deposit in sats")
  .action(async (opts) => {
    try {
      await cmdDeposit(opts.amount);
    } catch (e: any) {
      fail("deposit", e.message);
    }
  });

program
  .command("request-redeem")
  .description("Request withdrawal from hBTC vault (initiates cooldown)")
  .requiredOption("--shares <amount>", "Number of hBTC shares to redeem")
  .option("--express", "Use express redemption (faster, higher cost)", false)
  .action(async (opts) => {
    try {
      await cmdRequestRedeem(opts.shares, opts.express);
    } catch (e: any) {
      fail("request-redeem", e.message);
    }
  });

program
  .command("redeem")
  .description("Collect sBTC after redemption cooldown has expired")
  .requiredOption("--claim-id <id>", "Claim ID from the request-redeem step")
  .action(async (opts) => {
    try {
      await cmdRedeem(opts.claimId);
    } catch (e: any) {
      fail("redeem", e.message);
    }
  });

program.parse();
