/**
 * Vault Lifecycle Tests
 *
 * Tests the complete happy path and cancellation flows using:
 * - On-chain time (no Date.now() flakiness)
 * - PDA helpers (no duplication)
 * - Amount helpers (toU/fromU)
 * - Strict BN comparisons (no Number precision issues)
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
  assertBNEqual,
} from "./utils.spec";

describe("Vault Lifecycle", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.vitalfiVault as Program<VitalfiVault>;
  const authority = provider.wallet as anchor.Wallet;
  const pda = new PDA(program.programId);

  let mint: PublicKey;
  let authorityTokenAccount: PublicKey;
  let user1: Keypair;
  let user1TokenAccount: PublicKey;
  let user2: Keypair;
  let user2TokenAccount: PublicKey;

  before(async () => {
    // Create mint
    mint = await createMint(
      provider.connection,
      authority.payer,
      authority.publicKey,
      null,
      9
    );

    // Create token accounts
    authorityTokenAccount = await createAccount(
      provider.connection,
      authority.payer,
      mint,
      authority.publicKey
    );

    // Create test users
    user1 = Keypair.generate();
    user2 = Keypair.generate();

    // Airdrop SOL to users for rent
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(
        user1.publicKey,
        10 * anchor.web3.LAMPORTS_PER_SOL
      )
    );
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(
        user2.publicKey,
        10 * anchor.web3.LAMPORTS_PER_SOL
      )
    );

    // Create user token accounts and mint tokens
    user1TokenAccount = await createAccount(
      provider.connection,
      user1,
      mint,
      user1.publicKey
    );
    user2TokenAccount = await createAccount(
      provider.connection,
      user2,
      mint,
      user2.publicKey
    );

    // Mint tokens using toU helper
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
    await mintTo(
      provider.connection,
      authority.payer,
      mint,
      user2TokenAccount,
      authority.publicKey,
      toU(10000).toNumber()
    );
  });

  describe("Successful Vault Lifecycle", () => {
    const vaultId = new BN(1);
    let vaultPda: PublicKey;
    let vaultTokenPda: PublicKey;
    let user1PositionPda: PublicKey;
    let user2PositionPda: PublicKey;

    it("Initializes a vault", async () => {
      // Use PDA helpers instead of manual derivation
      vaultPda = pda.vault(authority.publicKey, vaultId);
      vaultTokenPda = pda.vaultToken(vaultPda);

      const cap = toU(1000);
      const targetApyBps = 1200; // 12%
      const minDeposit = toU(10);

      // Use on-chain time instead of Date.now()
      const now = await nowOnChain(provider.connection);
      const fundingEndTs = new BN(now + 5);
      const maturityTs = new BN(now + 7);

      await program.methods
        .initializeVault(vaultId, cap, targetApyBps, fundingEndTs, maturityTs, minDeposit)
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

      const vault = await program.account.vault.fetch(vaultPda);

      // Use assertBNEqual for precise comparison
      assertBNEqual(vault.vaultId, vaultId);
      assertBNEqual(vault.cap, cap);
      assert.strictEqual(vault.targetApyBps, targetApyBps);
      assert.deepEqual(vault.status, { funding: {} });
    });

    it("User 1 deposits 400 tokens", async () => {
      user1PositionPda = pda.position(vaultPda, user1.publicKey);
      const depositAmount = toU(400);

      await program.methods
        .deposit(depositAmount)
        .accounts({
          vault: vaultPda,
          vaultTokenAccount: vaultTokenPda,
          position: user1PositionPda,
          userTokenAccount: user1TokenAccount,
          user: user1.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([user1])
        .rpc();

      const position = await program.account.position.fetch(user1PositionPda);
      assertBNEqual(position.deposited, depositAmount);

      const vault = await program.account.vault.fetch(vaultPda);
      assertBNEqual(vault.totalDeposited, depositAmount);
    });

    it("User 2 deposits 300 tokens (reaches 2/3 threshold)", async () => {
      user2PositionPda = pda.position(vaultPda, user2.publicKey);
      const depositAmount = toU(300);

      await program.methods
        .deposit(depositAmount)
        .accounts({
          vault: vaultPda,
          vaultTokenAccount: vaultTokenPda,
          position: user2PositionPda,
          userTokenAccount: user2TokenAccount,
          user: user2.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([user2])
        .rpc();

      const vault = await program.account.vault.fetch(vaultPda);
      assertBNEqual(vault.totalDeposited, toU(700)); // 400 + 300
    });

    it("Finalizes funding successfully (≥ 2/3 cap)", async () => {
      const vault = await program.account.vault.fetch(vaultPda);

      // Wait using on-chain time instead of sleep
      await waitUntilUnix(provider.connection, vault.fundingEndTs.toNumber());

      // Get balance before finalize
      const authorityAccountBefore = await getAccount(
        provider.connection,
        authorityTokenAccount
      );
      const balanceBefore = new BN(authorityAccountBefore.amount.toString());

      await program.methods
        .finalizeFunding()
        .accounts({
          vault: vaultPda,
          vaultTokenAccount: vaultTokenPda,
          authorityTokenAccount: authorityTokenAccount,
          authority: authority.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();

      const vaultAfter = await program.account.vault.fetch(vaultPda);
      assert.deepEqual(vaultAfter.status, { active: {} });

      // Verify 700 tokens were withdrawn to authority
      const authorityAccountAfter = await getAccount(
        provider.connection,
        authorityTokenAccount
      );
      const balanceAfter = new BN(authorityAccountAfter.amount.toString());

      assertBNEqual(balanceAfter.sub(balanceBefore), toU(700));
    });

    it("Matures vault with returns (110% payout)", async () => {
      const vault = await program.account.vault.fetch(vaultPda);

      // Wait for maturity using on-chain time
      await waitUntilUnix(provider.connection, vault.maturityTs.toNumber());

      const returnAmount = toU(770); // 110% of 700

      // Authority returns capital + yield
      await mintTo(
        provider.connection,
        authority.payer,
        mint,
        authorityTokenAccount,
        authority.publicKey,
        returnAmount.toNumber()
      );

      await program.methods
        .matureVault(returnAmount)
        .accounts({
          vault: vaultPda,
          vaultTokenAccount: vaultTokenPda,
          authorityTokenAccount: authorityTokenAccount,
          authority: authority.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();

      const vaultAfter = await program.account.vault.fetch(vaultPda);
      assert.deepEqual(vaultAfter.status, { matured: {} });

      // Verify payout ratio (stored as u128)
      assert.strictEqual(vaultAfter.payoutNum.toString(), returnAmount.toString());
      assert.strictEqual(vaultAfter.payoutDen.toString(), toU(700).toString());
    });

    it("User 1 claims payout (440 tokens)", async () => {
      const balanceBefore = await getAccount(provider.connection, user1TokenAccount);

      await program.methods
        .claim()
        .accounts({
          vault: vaultPda,
          vaultTokenAccount: vaultTokenPda,
          position: user1PositionPda,
          userTokenAccount: user1TokenAccount,
          user: user1.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([user1])
        .rpc();

      const balanceAfter = await getAccount(provider.connection, user1TokenAccount);
      const received = new BN(balanceAfter.amount.toString()).sub(
        new BN(balanceBefore.amount.toString())
      );

      // User deposited 400, gets floor(400 * 770 / 700) = 440
      assertBNEqual(received, toU(440));
    });

    it("User 2 claims payout (330 tokens)", async () => {
      const balanceBefore = await getAccount(provider.connection, user2TokenAccount);

      await program.methods
        .claim()
        .accounts({
          vault: vaultPda,
          vaultTokenAccount: vaultTokenPda,
          position: user2PositionPda,
          userTokenAccount: user2TokenAccount,
          user: user2.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([user2])
        .rpc();

      const balanceAfter = await getAccount(provider.connection, user2TokenAccount);
      const received = new BN(balanceAfter.amount.toString()).sub(
        new BN(balanceBefore.amount.toString())
      );

      // User deposited 300, gets floor(300 * 770 / 700) = 330
      assertBNEqual(received, toU(330));
    });
  });

  describe("Failed Vault (Below 2/3 Threshold)", () => {
    const vaultId = new BN(2);
    let vaultPda: PublicKey;
    let vaultTokenPda: PublicKey;
    let user1PositionPda: PublicKey;

    it("Initializes vault", async () => {
      vaultPda = pda.vault(authority.publicKey, vaultId);
      vaultTokenPda = pda.vaultToken(vaultPda);

      const now = await nowOnChain(provider.connection);
      const fundingEndTs = new BN(now + 5);
      const maturityTs = new BN(now + 7);

      await program.methods
        .initializeVault(
          vaultId,
          toU(1000),
          1200,
          fundingEndTs,
          maturityTs,
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
    });

    it("User 1 deposits 600 tokens (below 2/3 threshold)", async () => {
      user1PositionPda = pda.position(vaultPda, user1.publicKey);
      const depositAmount = toU(600); // < 667 threshold

      await program.methods
        .deposit(depositAmount)
        .accounts({
          vault: vaultPda,
          vaultTokenAccount: vaultTokenPda,
          position: user1PositionPda,
          userTokenAccount: user1TokenAccount,
          user: user1.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([user1])
        .rpc();
    });

    it("Finalizes funding as canceled (< 2/3 cap)", async () => {
      const vault = await program.account.vault.fetch(vaultPda);
      await waitUntilUnix(provider.connection, vault.fundingEndTs.toNumber());

      await program.methods
        .finalizeFunding()
        .accounts({
          vault: vaultPda,
          vaultTokenAccount: vaultTokenPda,
          authorityTokenAccount: authorityTokenAccount,
          authority: authority.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();

      const vaultAfter = await program.account.vault.fetch(vaultPda);
      assert.deepEqual(vaultAfter.status, { canceled: {} });

      // Verify funds remain in vault
      const vaultAccount = await getAccount(provider.connection, vaultTokenPda);
      assertBNEqual(new BN(vaultAccount.amount.toString()), toU(600));
    });

    it("User 1 claims full refund", async () => {
      const balanceBefore = await getAccount(provider.connection, user1TokenAccount);

      await program.methods
        .claim()
        .accounts({
          vault: vaultPda,
          vaultTokenAccount: vaultTokenPda,
          position: user1PositionPda,
          userTokenAccount: user1TokenAccount,
          user: user1.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([user1])
        .rpc();

      const balanceAfter = await getAccount(provider.connection, user1TokenAccount);
      const received = new BN(balanceAfter.amount.toString()).sub(
        new BN(balanceBefore.amount.toString())
      );

      assertBNEqual(received, toU(600)); // Full refund
    });
  });
});
