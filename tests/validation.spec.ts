/**
 * Validation & Error Coverage Tests
 *
 * Refactored from vitalfi-vault.ts using:
 * - toU() for amounts
 * - nowOnChain() + waitUntilUnix() for timing
 * - PDA helpers
 * - expectErrorContains() for errors
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

describe("Validation & Error Coverage", () => {
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

  describe("Edge Cases", () => {
    const vaultId = new BN(3);
    let vaultPda: PublicKey;
    let vaultTokenPda: PublicKey;

    it("Fails to deposit below minimum", async () => {
      vaultPda = pda.vault(authority.publicKey, vaultId);
      vaultTokenPda = pda.vaultToken(vaultPda);

      const now = await nowOnChain(provider.connection);

      await program.methods
        .initializeVault(
          vaultId,
          toU(1000),
          1200,
          new BN(now + 3600),
          new BN(now + 7200),
          toU(10)
        )
        .accounts({
          vault: vaultPda,
          vaultTokenAccount: vaultTokenPda,
          assetMint: mint,
          authority: authority.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .rpc();

      const user1Position = pda.position(vaultPda, user1.publicKey);

      try {
        await program.methods
          .deposit(toU(5)) // Below min 10
          .accounts({
            vault: vaultPda,
            vaultTokenAccount: vaultTokenPda,
            position: user1Position,
            userTokenAccount: user1TokenAccount,
            user: user1.publicKey,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([user1])
          .rpc();
        assert.fail("Should have failed with BelowMinDeposit");
      } catch (err: any) {
        expectErrorContains(err, "BelowMinDeposit");
      }
    });

    it("Fails to deposit exceeding cap", async () => {
      const user1Position = pda.position(vaultPda, user1.publicKey);

      try {
        await program.methods
          .deposit(toU(1001)) // Exceeds 1000 cap
          .accounts({
            vault: vaultPda,
            vaultTokenAccount: vaultTokenPda,
            position: user1Position,
            userTokenAccount: user1TokenAccount,
            user: user1.publicKey,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([user1])
          .rpc();
        assert.fail("Should have failed with CapExceeded");
      } catch (err: any) {
        expectErrorContains(err, "CapExceeded");
      }
    });
  });

  describe("Validation Errors", () => {
    it("Fails with InvalidCapacity - zero cap", async () => {
      const testVaultId = new BN(101);
      const testVaultPda = pda.vault(authority.publicKey, testVaultId);
      const testVaultToken = pda.vaultToken(testVaultPda);

      const now = await nowOnChain(provider.connection);

      try {
        await program.methods
          .initializeVault(
            testVaultId,
            new BN(0), // Zero cap
            1200,
            new BN(now + 3600),
            new BN(now + 7200),
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

    it("Fails with InvalidTimestamps - funding_end in past", async () => {
      const testVaultId = new BN(102);
      const testVaultPda = pda.vault(authority.publicKey, testVaultId);
      const testVaultToken = pda.vaultToken(testVaultPda);

      const now = await nowOnChain(provider.connection);

      try {
        await program.methods
          .initializeVault(
            testVaultId,
            toU(1000),
            1200,
            new BN(now - 100), // Past
            new BN(now + 7200),
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
        assert.fail("Should have failed with InvalidTimestamps");
      } catch (err: any) {
        expectErrorContains(err, "InvalidTimestamps");
      }
    });

    it("Fails with InvalidTimestamps - maturity before funding_end", async () => {
      const testVaultId = new BN(103);
      const testVaultPda = pda.vault(authority.publicKey, testVaultId);
      const testVaultToken = pda.vaultToken(testVaultPda);

      const now = await nowOnChain(provider.connection);

      try {
        await program.methods
          .initializeVault(
            testVaultId,
            toU(1000),
            1200,
            new BN(now + 7200),
            new BN(now + 3600), // Before funding_end
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
        assert.fail("Should have failed with InvalidTimestamps");
      } catch (err: any) {
        expectErrorContains(err, "InvalidTimestamps");
      }
    });

    it("Fails with ZeroDeposit", async () => {
      const testVaultId = new BN(104);
      const testVaultPda = pda.vault(authority.publicKey, testVaultId);
      const testVaultToken = pda.vaultToken(testVaultPda);

      const now = await nowOnChain(provider.connection);

      await program.methods
        .initializeVault(
          testVaultId,
          toU(1000),
          1200,
          new BN(now + 3600),
          new BN(now + 7200),
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

      const testPosition = pda.position(testVaultPda, user1.publicKey);

      try {
        await program.methods
          .deposit(new BN(0)) // Zero
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
        assert.fail("Should have failed with ZeroDeposit");
      } catch (err: any) {
        expectErrorContains(err, "ZeroDeposit");
      }
    });
  });

  describe("Boundary Tests", () => {
    it("Succeeds with exact 2/3 threshold (667 out of 1000)", async () => {
      const testVaultId = new BN(200);
      const testVaultPda = pda.vault(authority.publicKey, testVaultId);
      const testVaultToken = pda.vaultToken(testVaultPda);

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

      const testPosition = pda.position(testVaultPda, user1.publicKey);

      // Deposit exactly 667 tokens (exact 2/3 threshold)
      await program.methods
        .deposit(toU(667))
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

      // Wait for funding to end
      await waitUntilUnix(provider.connection, now + 5);

      // Should succeed
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

      const vault = await program.account.vault.fetch(testVaultPda);
      assert.deepEqual(vault.status, { active: {} });
    });

    it("Fails with 666 tokens (just below 2/3 threshold)", async () => {
      const testVaultId = new BN(201);
      const testVaultPda = pda.vault(authority.publicKey, testVaultId);
      const testVaultToken = pda.vaultToken(testVaultPda);

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

      const testPosition = pda.position(testVaultPda, user1.publicKey);

      // Deposit 666 tokens (just below threshold)
      await program.methods
        .deposit(toU(666))
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

      // Wait for funding to end
      await waitUntilUnix(provider.connection, now + 5);

      // Should be canceled
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

      const vault = await program.account.vault.fetch(testVaultPda);
      assert.deepEqual(vault.status, { canceled: {} });
    });
  });

  describe("Status and Timing Errors", () => {
    it("Fails with FundingEnded when depositing after funding period", async () => {
      const testVaultId = new BN(300);
      const testVaultPda = pda.vault(authority.publicKey, testVaultId);
      const testVaultToken = pda.vaultToken(testVaultPda);

      const now = await nowOnChain(provider.connection);

      await program.methods
        .initializeVault(
          testVaultId,
          toU(1000),
          1200,
          new BN(now + 2), // Ends in 2 seconds
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

      // Wait for funding to end
      await waitUntilUnix(provider.connection, now + 3);

      const testPosition = pda.position(testVaultPda, user1.publicKey);

      try {
        await program.methods
          .deposit(toU(100))
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
        assert.fail("Should have failed with FundingEnded");
      } catch (err: any) {
        expectErrorContains(err, "FundingEnded");
      }
    });

    it("Fails with FundingNotEnded when finalizing before funding period ends", async () => {
      const testVaultId = new BN(301);
      const testVaultPda = pda.vault(authority.publicKey, testVaultId);
      const testVaultToken = pda.vaultToken(testVaultPda);

      const now = await nowOnChain(provider.connection);

      await program.methods
        .initializeVault(
          testVaultId,
          toU(1000),
          1200,
          new BN(now + 6), // Ends in 6 seconds
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

      try {
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
        assert.fail("Should have failed with FundingNotEnded");
      } catch (err: any) {
        expectErrorContains(err, "FundingNotEnded");
      }
    });

    it("Fails with NotMatured when maturing before maturity time", async () => {
      const testVaultId = new BN(302);
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
          new BN(now + 10), // Matures in 10 seconds
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

      // Deposit and finalize
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

      // Wait for funding to end (now + 2)
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

      try {
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
        assert.fail("Should have failed with NotMatured");
      } catch (err: any) {
        expectErrorContains(err, "NotMatured");
      }
    });

    it("Fails with InvalidStatus when maturing twice", async () => {
      const testVaultId = new BN(303);
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

      try {
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
        assert.fail("Should have failed - vault already matured");
      } catch (err: any) {
        // Vault is in Matured status, not Active, so constraint check fails
        expectErrorContains(err, "Invalid");
      }
    });

    it("Fails with account not found when claiming with no deposit", async () => {
      const testVaultId = new BN(304);
      const testVaultPda = pda.vault(authority.publicKey, testVaultId);
      const testVaultToken = pda.vaultToken(testVaultPda);
      const position1 = pda.position(testVaultPda, user1.publicKey);

      // Create second user
      const user2 = Keypair.generate();
      await provider.connection.confirmTransaction(
        await provider.connection.requestAirdrop(
          user2.publicKey,
          10 * anchor.web3.LAMPORTS_PER_SOL
        )
      );

      const user2TokenAccount = await createAccount(
        provider.connection,
        user2,
        mint,
        user2.publicKey
      );

      const position2 = pda.position(testVaultPda, user2.publicKey);

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

      // User1 deposits
      await program.methods
        .deposit(toU(700))
        .accounts({
          vault: testVaultPda,
          vaultTokenAccount: testVaultToken,
          position: position1,
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

      // User2 tries to claim without depositing
      try {
        await program.methods
          .claim()
          .accounts({
            vault: testVaultPda,
            vaultTokenAccount: testVaultToken,
            position: position2,
            userTokenAccount: user2TokenAccount,
            user: user2.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([user2])
          .rpc();
        assert.fail("Should have failed - no position account exists");
      } catch (err: any) {
        // Position account doesn't exist for user2, or constraint violation
        const errorStr = err.message || err.toString();
        assert.isTrue(
          errorStr.includes("account") || errorStr.includes("constraint"),
          `Expected error about account, got: ${errorStr}`
        );
      }
    });

    it("Fails with InvalidStatus when depositing to canceled vault", async () => {
      const testVaultId = new BN(305);
      const testVaultPda = pda.vault(authority.publicKey, testVaultId);
      const testVaultToken = pda.vaultToken(testVaultPda);
      const testPosition = pda.position(testVaultPda, user1.publicKey);

      const now = await nowOnChain(provider.connection);

      await program.methods
        .initializeVault(
          testVaultId,
          toU(1000),
          1200,
          new BN(now + 3),
          new BN(now + 5),
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

      // Deposit below threshold
      await program.methods
        .deposit(toU(100))
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

      await waitUntilUnix(provider.connection, now + 6);

      // Finalize as canceled
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

      // Try to deposit to canceled vault
      try {
        await program.methods
          .deposit(toU(100))
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
        assert.fail("Should have failed with InvalidStatus");
      } catch (err: any) {
        expectErrorContains(err, "InvalidStatus");
      }
    });

    it("Fails with CannotCloseWithFunds when closing vault with remaining funds", async () => {
      const testVaultId = new BN(306);
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

      // Try to close vault with funds still in it (user hasn't claimed)
      try {
        await program.methods
          .closeVault()
          .accounts({
            vault: testVaultPda,
            vaultTokenAccount: testVaultToken,
            authority: authority.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .rpc();
        assert.fail("Should have failed with CannotCloseWithFunds");
      } catch (err: any) {
        expectErrorContains(err, "CannotCloseWithFunds");
      }
    });
  });
});
