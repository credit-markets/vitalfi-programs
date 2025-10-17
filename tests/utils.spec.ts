import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { VitalfiVault } from "../target/types/vitalfi_vault";
import { PublicKey, Connection } from "@solana/web3.js";
import { assert } from "chai";

// ============================================
// Constants
// ============================================

export const DECIMALS = 9;
export const UNIT = new BN(10).pow(new BN(DECIMALS));

// ============================================
// Amount Conversion Helpers
// ============================================

/**
 * Convert human-readable token amount to smallest units (with decimals)
 * @example toU(100) => 100_000_000_000 (for 9 decimals)
 */
export function toU(n: number): BN {
  return new BN(n).mul(UNIT);
}

/**
 * Convert smallest units back to human-readable amount
 */
export function fromU(bn: BN): number {
  return bn.div(UNIT).toNumber();
}

// ============================================
// On-Chain Time Helpers
// ============================================

/**
 * Get current Unix timestamp from on-chain block time
 * Eliminates dependency on local system clock
 */
export async function nowOnChain(conn: Connection): Promise<number> {
  const slot = await conn.getSlot();
  const t = await conn.getBlockTime(slot);
  if (t === null) throw new Error("blocktime unavailable");
  return t;
}

/**
 * Poll until on-chain time reaches target Unix timestamp
 * Prevents test flakiness from sleep-based timing
 */
export async function waitUntilUnix(
  conn: Connection,
  target: number
): Promise<void> {
  for (;;) {
    const t = await nowOnChain(conn);
    if (t >= target) break;
    await new Promise((r) => setTimeout(r, 200)); // Short poll interval
  }
}

/**
 * Wait for a duration in seconds using on-chain time
 */
export async function waitSeconds(conn: Connection, seconds: number): Promise<void> {
  const start = await nowOnChain(conn);
  await waitUntilUnix(conn, start + seconds);
}

// ============================================
// PDA Helpers
// ============================================

/**
 * Centralized PDA derivation helpers
 */
export class PDA {
  private programId: PublicKey;

  constructor(programId: PublicKey) {
    this.programId = programId;
  }

  vault(authority: PublicKey, vaultId: BN): PublicKey {
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from("vault"),
        authority.toBuffer(),
        vaultId.toArrayLike(Buffer, "le", 8),
      ],
      this.programId
    )[0];
  }

  vaultToken(vault: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("vault_token"), vault.toBuffer()],
      this.programId
    )[0];
  }

  position(vault: PublicKey, user: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("position"), vault.toBuffer(), user.toBuffer()],
      this.programId
    )[0];
  }
}

// ============================================
// Error Assertion Helpers
// ============================================

/**
 * Assert that an error matches an expected Anchor error code
 * More robust than substring matching
 */
export function expectAnchorError(err: any, expectedCode: string): void {
  const gotCode = err?.error?.errorCode?.code || err?.code;
  const gotMsg = err?.error?.errorMessage || err?.message || err?.toString();

  // Try to extract error code from message if not in structured form
  if (!gotCode && gotMsg) {
    // Check if error message contains the expected code
    if (gotMsg.includes(expectedCode)) {
      return; // Success
    }
  }

  assert.strictEqual(
    gotCode,
    expectedCode,
    `Expected error code ${expectedCode}, got ${gotCode}. Message: ${gotMsg}`
  );
}

/**
 * Assert that an error message contains expected text
 * Fallback for non-Anchor errors
 */
export function expectErrorContains(err: any, expectedText: string): void {
  const errorStr = err?.message || err?.name || err?.toString();
  assert.include(
    errorStr,
    expectedText,
    `Expected error to contain "${expectedText}", got: ${errorStr}`
  );
}

// ============================================
// BN Assertion Helpers
// ============================================

/**
 * Assert two BN values are equal using string comparison
 * Avoids precision issues with Number conversion
 */
export function assertBNEqual(actual: BN, expected: BN, message?: string): void {
  assert.strictEqual(
    actual.toString(),
    expected.toString(),
    message || `Expected ${expected.toString()}, got ${actual.toString()}`
  );
}

/**
 * Assert BN is within expected range (inclusive)
 */
export function assertBNInRange(
  value: BN,
  min: BN,
  max: BN,
  message?: string
): void {
  assert.isTrue(
    value.gte(min) && value.lte(max),
    message ||
      `Expected ${value.toString()} to be between ${min.toString()} and ${max.toString()}`
  );
}

// ============================================
// Vault Test Helpers
// ============================================

export interface VaultParams {
  vaultId: BN;
  cap: BN;
  targetApyBps: number;
  fundingEndTs: BN;
  maturityTs: BN;
  minDeposit: BN;
}

/**
 * Calculate 2/3 threshold for a vault cap using ceiling division
 */
export function twoThirdsThreshold(cap: BN): BN {
  // ceil(2/3 * cap) = (cap * 2 + 2) / 3
  return cap.muln(2).addn(2).divn(3);
}

/**
 * Calculate expected payout for a position
 */
export function calculatePayout(
  deposited: BN,
  payoutNum: BN,
  payoutDen: BN
): BN {
  // floor(deposited * payoutNum / payoutDen)
  const depositedU128 = deposited.toArrayLike(Buffer, "le", 16);
  const depositedBig = new BN(depositedU128);

  return deposited.mul(payoutNum).div(payoutDen);
}

// ============================================
// Transaction Helpers
// ============================================

/**
 * Send transaction with retry on blockhash not found
 */
export async function sendAndConfirmWithRetry(
  connection: Connection,
  transaction: anchor.web3.Transaction,
  signers: anchor.web3.Signer[],
  maxRetries = 3
): Promise<string> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await connection.sendTransaction(transaction, signers, {
        skipPreflight: false,
        preflightCommitment: "confirmed",
      });
    } catch (err: any) {
      if (err.message?.includes("BlockhashNotFound") && i < maxRetries - 1) {
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      throw err;
    }
  }
  throw new Error("Transaction failed after retries");
}
