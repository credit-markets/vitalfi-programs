/**
 * Security Tests
 *
 * Refactored from vitalfi-vault.ts using:
 * - toU() for amounts
 * - nowOnChain() + waitUntilUnix() for timing
 * - PDA helpers
 * - assertBNEqual() for comparisons
 */

import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { VitalfiVault } from "../target/types/vitalfi_vault";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { assert } from "chai";
import {
  nowOnChain,
  waitUntilUnix,
  toU,
  PDA,
  expectErrorContains,
} from "./utils.spec";

describe("Security Tests", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.vitalfiVault as Program<VitalfiVault>;
  const authority = provider.wallet as anchor.Wallet;
  const pda = new PDA(program.programId);

  let mint: PublicKey;
  let authorityTokenAccount: PublicKey;
  let user1: Keypair;
  let user1TokenAccount: PublicKey;

  before(async () => {
    mint = await createMint(
      provider.connection,
      authority.payer,
      authority.publicKey,
      null,
      9
    );

    authorityTokenAccount = await createAccount(
      provider.connection,
      authority.payer,
      mint,
      authority.publicKey
    );

    user1 = Keypair.generate();

    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(
        user1.publicKey,
        10 * anchor.web3.LAMPORTS_PER_SOL
      )
    );

    user1TokenAccount = await createAccount(
      provider.connection,
      user1,
      mint,
      user1.publicKey
    );

    await mintTo(
      provider.connection,
      authority.payer,
      mint,
      authorityTokenAccount,
      authority.publicKey,
      toU(100000).toNumber()
    );

    await mintTo(
      provider.connection,
      authority.payer,
      mint,
      user1TokenAccount,
      authority.publicKey,
      toU(10000).toNumber()
    );
  });

  describe("Balance Validation in mature_vault", () => {
    it("Validates actual transferred amount matches claimed amount", async () => {
      const testVaultId = new BN(400);
      const testVaultPda = pda.vault(authority.publicKey, testVaultId);
      const testVaultToken = pda.vaultToken(testVaultPda);
      const testPosition = pda.position(testVaultPda, user1.publicKey);

      const now = await nowOnChain(provider.connection);

      await program.methods
        .initializeVault(
          testVaultId,
          toU(1000),
          1200,
          new BN(now + 2),
          new BN(now + 4),
          toU(10)
        )
        .accounts({
          vault: testVaultPda,
          vaultTokenAccount: testVaultToken,
          assetMint: mint,
          authority: authority.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .rpc();

      await program.methods
        .deposit(toU(700))
        .accounts({
          vault: testVaultPda,
          vaultTokenAccount: testVaultToken,
          position: testPosition,
          userTokenAccount: user1TokenAccount,
          user: user1.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([user1])
        .rpc();

      await waitUntilUnix(provider.connection, now + 3);

      await program.methods
        .finalizeFunding()
        .accounts({
          vault: testVaultPda,
          vaultTokenAccount: testVaultToken,
          authorityTokenAccount: authorityTokenAccount,
          authority: authority.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();

      await waitUntilUnix(provider.connection, now + 5);

      // Mature vault with correct amount (should succeed)
      await program.methods
        .matureVault(toU(770))
        .accounts({
          vault: testVaultPda,
          vaultTokenAccount: testVaultToken,
          authorityTokenAccount: authorityTokenAccount,
          authority: authority.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();

      const vault = await program.account.vault.fetch(testVaultPda);
      assert.deepEqual(vault.status, { matured: {} });

      // Payout ratio: 770/700 = 1.1 (110%)
      assert.strictEqual(vault.payoutNum.toString(), toU(770).toString());
      assert.strictEqual(vault.payoutDen.toString(), toU(700).toString());
    });
  });

  describe("MAX_VAULT_CAP Validation", () => {
    it("Fails with InvalidCapacity when cap exceeds MAX_VAULT_CAP", async () => {
      const testVaultId = new BN(401);
      const testVaultPda = pda.vault(authority.publicKey, testVaultId);
      const testVaultToken = pda.vaultToken(testVaultPda);

      const now = await nowOnChain(provider.connection);

      // MAX_VAULT_CAP = u64::MAX / 3
      // Try to initialize with cap > MAX_VAULT_CAP
      const maxCap = new BN("6148914691236517205"); // (u64::MAX / 3) + 1

      try {
        await program.methods
          .initializeVault(
            testVaultId,
            maxCap,
            1200,
            new BN(now + 100),
            new BN(now + 3600),
            toU(10)
          )
          .accounts({
            vault: testVaultPda,
            vaultTokenAccount: testVaultToken,
            assetMint: mint,
            authority: authority.publicKey,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
            rent: anchor.web3.SYSVAR_RENT_PUBKEY,
          })
          .rpc();
        assert.fail("Should have failed with InvalidCapacity");
      } catch (err: any) {
        expectErrorContains(err, "InvalidCapacity");
      }
    });
  });

  describe("Dust Tolerance in close_vault", () => {
    it("Allows closing vault with small dust amount (≤1000)", async () => {
      const testVaultId = new BN(402);
      const testVaultPda = pda.vault(authority.publicKey, testVaultId);
      const testVaultToken = pda.vaultToken(testVaultPda);
      const testPosition = pda.position(testVaultPda, user1.publicKey);

      const now = await nowOnChain(provider.connection);

      await program.methods
        .initializeVault(
          testVaultId,
          toU(1000),
          1200,
          new BN(now + 2),
          new BN(now + 4),
          toU(10)
        )
        .accounts({
          vault: testVaultPda,
          vaultTokenAccount: testVaultToken,
          assetMint: mint,
          authority: authority.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .rpc();

      await program.methods
        .deposit(toU(700))
        .accounts({
          vault: testVaultPda,
          vaultTokenAccount: testVaultToken,
          position: testPosition,
          userTokenAccount: user1TokenAccount,
          user: user1.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([user1])
        .rpc();

      await waitUntilUnix(provider.connection, now + 3);

      await program.methods
        .finalizeFunding()
        .accounts({
          vault: testVaultPda,
          vaultTokenAccount: testVaultToken,
          authorityTokenAccount: authorityTokenAccount,
          authority: authority.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();

      await waitUntilUnix(provider.connection, now + 5);

      await program.methods
        .matureVault(toU(770))
        .accounts({
          vault: testVaultPda,
          vaultTokenAccount: testVaultToken,
          authorityTokenAccount: authorityTokenAccount,
          authority: authority.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();

      // User claims
      await program.methods
        .claim()
        .accounts({
          vault: testVaultPda,
          vaultTokenAccount: testVaultToken,
          position: testPosition,
          userTokenAccount: user1TokenAccount,
          user: user1.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([user1])
        .rpc();

      // Check for dust
      const vaultTokenAccountBefore = await getAccount(
        provider.connection,
        testVaultToken
      );

      // If dust amount is ≤ MAX_DUST_AMOUNT (1000), closing should succeed
      if (Number(vaultTokenAccountBefore.amount) <= 1000) {
        await program.methods
          .closeVault()
          .accounts({
            vault: testVaultPda,
            vaultTokenAccount: testVaultToken,
            authority: authority.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .rpc();

        // Vault should be closed successfully
        try {
          await program.account.vault.fetch(testVaultPda);
          assert.fail("Vault should be closed");
        } catch (err: any) {
          expectErrorContains(err, "Account does not exist");
        }

        // Vault token account should also be closed
        try {
          await getAccount(provider.connection, testVaultToken);
          assert.fail("Vault token account should be closed");
        } catch (err: any) {
          const errorStr = err.message || err.name || err.toString();
          assert.isTrue(
            errorStr.includes("could not find") ||
            errorStr.includes("TokenAccountNotFoundError") ||
            errorStr.includes("not found"),
            `Expected token account not found error, got: ${errorStr}`
          );
        }
      }
    });
  });

  describe("Position Closure Security", () => {
    it("Prevents double claiming by closing position account", async () => {
      const testVaultId = new BN(403);
      const testVaultPda = pda.vault(authority.publicKey, testVaultId);
      const testVaultToken = pda.vaultToken(testVaultPda);
      const testPosition = pda.position(testVaultPda, user1.publicKey);

      const now = await nowOnChain(provider.connection);

      await program.methods
        .initializeVault(
          testVaultId,
          toU(1000),
          1200,
          new BN(now + 2),
          new BN(now + 4),
          toU(10)
        )
        .accounts({
          vault: testVaultPda,
          vaultTokenAccount: testVaultToken,
          assetMint: mint,
          authority: authority.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .rpc();

      await program.methods
        .deposit(toU(700))
        .accounts({
          vault: testVaultPda,
          vaultTokenAccount: testVaultToken,
          position: testPosition,
          userTokenAccount: user1TokenAccount,
          user: user1.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([user1])
        .rpc();

      await waitUntilUnix(provider.connection, now + 3);

      await program.methods
        .finalizeFunding()
        .accounts({
          vault: testVaultPda,
          vaultTokenAccount: testVaultToken,
          authorityTokenAccount: authorityTokenAccount,
          authority: authority.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();

      await waitUntilUnix(provider.connection, now + 5);

      await program.methods
        .matureVault(toU(770))
        .accounts({
          vault: testVaultPda,
          vaultTokenAccount: testVaultToken,
          authorityTokenAccount: authorityTokenAccount,
          authority: authority.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();

      // First claim (should succeed)
      const balanceBefore = await getAccount(provider.connection, user1TokenAccount);

      await program.methods
        .claim()
        .accounts({
          vault: testVaultPda,
          vaultTokenAccount: testVaultToken,
          position: testPosition,
          userTokenAccount: user1TokenAccount,
          user: user1.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([user1])
        .rpc();

      const balanceAfter = await getAccount(provider.connection, user1TokenAccount);
      const received = new BN(balanceAfter.amount.toString()).sub(
        new BN(balanceBefore.amount.toString())
      );

      // User deposited 700, gets 770
      assert.strictEqual(received.toString(), toU(770).toString());

      // Verify position account is closed
      try {
        await program.account.position.fetch(testPosition);
        assert.fail("Position should be closed after claim");
      } catch (err: any) {
        expectErrorContains(err, "Account does not exist");
      }

      // Try to claim again (should fail because position doesn't exist)
      try {
        await program.methods
          .claim()
          .accounts({
            vault: testVaultPda,
            vaultTokenAccount: testVaultToken,
            position: testPosition,
            userTokenAccount: user1TokenAccount,
            user: user1.publicKey,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([user1])
          .rpc();
        assert.fail("Should have failed - position account closed");
      } catch (err: any) {
        const errorStr = err.message || err.toString();
        assert.isTrue(
          errorStr.includes("Account does not exist") ||
            errorStr.includes("AccountNotInitialized"),
          `Expected account not found error, got: ${errorStr}`
        );
      }
    });
  });
});
