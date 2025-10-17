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

describe("vitalfi-vault", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.vitalfiVault as Program<VitalfiVault>;
  const authority = provider.wallet as anchor.Wallet;

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
      await provider.connection.requestAirdrop(user1.publicKey, 10 * anchor.web3.LAMPORTS_PER_SOL)
    );
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(user2.publicKey, 10 * anchor.web3.LAMPORTS_PER_SOL)
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

    // Mint tokens to users (1000 tokens each)
    await mintTo(
      provider.connection,
      authority.payer,
      mint,
      user1TokenAccount,
      authority.publicKey,
      1000_000_000_000
    );
    await mintTo(
      provider.connection,
      authority.payer,
      mint,
      user2TokenAccount,
      authority.publicKey,
      1000_000_000_000
    );
  });

  describe("Successful Vault Lifecycle", () => {
    const vaultId = new BN(1);
    let vaultPda: PublicKey;
    let vaultTokenAccount: PublicKey;
    let user1Position: PublicKey;
    let user2Position: PublicKey;

    it("Initializes a vault", async () => {
      [vaultPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("vault"),
          authority.publicKey.toBuffer(),
          vaultId.toArrayLike(Buffer, "le", 8),
        ],
        program.programId
      );

      [vaultTokenAccount] = PublicKey.findProgramAddressSync(
        [Buffer.from("vault_token"), vaultPda.toBuffer()],
        program.programId
      );

      const cap = new BN(1000_000_000_000); // 1000 tokens
      const targetApyBps = 1200; // 12%
      const now = Math.floor(Date.now() / 1000);
      const fundingEndTs = new BN(now + 2); // 2 seconds from now
      const maturityTs = new BN(now + 4); // 4 seconds from now
      const minDeposit = new BN(10_000_000_000); // 10 tokens

      await program.methods
        .initializeVault(vaultId, cap, targetApyBps, fundingEndTs, maturityTs, minDeposit)
        .accounts({
          vault: vaultPda,
          vaultTokenAccount: vaultTokenAccount,
          assetMint: mint,
          authority: authority.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .rpc();

      const vault = await program.account.vault.fetch(vaultPda);
      assert.equal(vault.vaultId.toNumber(), vaultId.toNumber());
      assert.equal(vault.cap.toNumber(), cap.toNumber());
      assert.equal(vault.targetApyBps, targetApyBps);
      assert.deepEqual(vault.status, { funding: {} }); // Funding
    });

    it("User 1 deposits 400 tokens", async () => {
      [user1Position] = PublicKey.findProgramAddressSync(
        [Buffer.from("position"), vaultPda.toBuffer(), user1.publicKey.toBuffer()],
        program.programId
      );

      const depositAmount = new BN(400_000_000_000); // 400 tokens

      await program.methods
        .deposit(depositAmount)
        .accounts({
          vault: vaultPda,
          vaultTokenAccount: vaultTokenAccount,
          position: user1Position,
          userTokenAccount: user1TokenAccount,
          user: user1.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([user1])
        .rpc();

      const position = await program.account.position.fetch(user1Position);
      assert.equal(position.deposited.toNumber(), depositAmount.toNumber());

      const vault = await program.account.vault.fetch(vaultPda);
      assert.equal(vault.totalDeposited.toNumber(), depositAmount.toNumber());
    });

    it("User 2 deposits 300 tokens (reaches 2/3 threshold)", async () => {
      [user2Position] = PublicKey.findProgramAddressSync(
        [Buffer.from("position"), vaultPda.toBuffer(), user2.publicKey.toBuffer()],
        program.programId
      );

      const depositAmount = new BN(300_000_000_000); // 300 tokens

      await program.methods
        .deposit(depositAmount)
        .accounts({
          vault: vaultPda,
          vaultTokenAccount: vaultTokenAccount,
          position: user2Position,
          userTokenAccount: user2TokenAccount,
          user: user2.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([user2])
        .rpc();

      const vault = await program.account.vault.fetch(vaultPda);
      assert.equal(vault.totalDeposited.toNumber(), 700_000_000_000); // 700 tokens total
    });

    it("Finalizes funding successfully (≥ 2/3 cap)", async () => {
      // Wait for funding period to end (3 seconds)
      const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
      await sleep(3000);

      await program.methods
        .finalizeFunding()
        .accounts({
          vault: vaultPda,
          vaultTokenAccount: vaultTokenAccount,
          authorityTokenAccount: authorityTokenAccount,
          authority: authority.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();

      const vault = await program.account.vault.fetch(vaultPda);
      assert.deepEqual(vault.status, { active: {} }); // Active

      // Verify funds were withdrawn to authority
      const authorityAccount = await getAccount(provider.connection, authorityTokenAccount);
      assert.equal(authorityAccount.amount.toString(), "700000000000");
    });

    it("Matures vault with returns (110% payout)", async () => {
      // Wait for maturity (2 more seconds)
      const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
      await sleep(2000);

      // Authority returns 770 tokens (10% yield)
      // Mint 770 tokens to authority's account (simulating the return with profit)
      const returnAmount = new BN(770_000_000_000);
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
          vaultTokenAccount: vaultTokenAccount,
          authorityTokenAccount: authorityTokenAccount,
          authority: authority.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();

      const vault = await program.account.vault.fetch(vaultPda);
      assert.deepEqual(vault.status, { matured: {} }); // Matured
      assert.equal(vault.payoutNum.toString(), "770000000000");
      assert.equal(vault.payoutDen.toString(), "700000000000");
    });

    it("User 1 claims payout (440 tokens)", async () => {
      const balanceBefore = await getAccount(provider.connection, user1TokenAccount);

      await program.methods
        .claim()
        .accounts({
          vault: vaultPda,
          vaultTokenAccount: vaultTokenAccount,
          position: user1Position,
          userTokenAccount: user1TokenAccount,
          user: user1.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([user1])
        .rpc();

      const balanceAfter = await getAccount(provider.connection, user1TokenAccount);
      // User deposited 400, should get floor(400 * 770 / 700) = 440
      const expectedPayout = 440_000_000_000;
      assert.equal(
        (balanceAfter.amount - balanceBefore.amount).toString(),
        expectedPayout.toString()
      );
    });

    it("User 2 claims payout (330 tokens)", async () => {
      const balanceBefore = await getAccount(provider.connection, user2TokenAccount);

      await program.methods
        .claim()
        .accounts({
          vault: vaultPda,
          vaultTokenAccount: vaultTokenAccount,
          position: user2Position,
          userTokenAccount: user2TokenAccount,
          user: user2.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([user2])
        .rpc();

      const balanceAfter = await getAccount(provider.connection, user2TokenAccount);
      // User deposited 300, should get floor(300 * 770 / 700) = 330
      const expectedPayout = 330_000_000_000;
      assert.equal(
        (balanceAfter.amount - balanceBefore.amount).toString(),
        expectedPayout.toString()
      );
    });
  });

  describe("Failed Vault (Below 2/3 Threshold)", () => {
    const vaultId = new BN(2);
    let vaultPda: PublicKey;
    let vaultTokenAccount: PublicKey;
    let user1Position: PublicKey;

    it("Initializes vault", async () => {
      [vaultPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("vault"),
          authority.publicKey.toBuffer(),
          vaultId.toArrayLike(Buffer, "le", 8),
        ],
        program.programId
      );

      [vaultTokenAccount] = PublicKey.findProgramAddressSync(
        [Buffer.from("vault_token"), vaultPda.toBuffer()],
        program.programId
      );

      const cap = new BN(1000_000_000_000);
      const targetApyBps = 1200;
      const now = Math.floor(Date.now() / 1000);
      const fundingEndTs = new BN(now + 2); // 2 seconds from now
      const maturityTs = new BN(now + 3600);
      const minDeposit = new BN(10_000_000_000);

      await program.methods
        .initializeVault(vaultId, cap, targetApyBps, fundingEndTs, maturityTs, minDeposit)
        .accounts({
          vault: vaultPda,
          vaultTokenAccount: vaultTokenAccount,
          assetMint: mint,
          authority: authority.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .rpc();
    });

    it("User 1 deposits 600 tokens (below 2/3 threshold)", async () => {
      [user1Position] = PublicKey.findProgramAddressSync(
        [Buffer.from("position"), vaultPda.toBuffer(), user1.publicKey.toBuffer()],
        program.programId
      );

      const depositAmount = new BN(600_000_000_000); // 600 tokens (< 667 threshold)

      await program.methods
        .deposit(depositAmount)
        .accounts({
          vault: vaultPda,
          vaultTokenAccount: vaultTokenAccount,
          position: user1Position,
          userTokenAccount: user1TokenAccount,
          user: user1.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([user1])
        .rpc();
    });

    it("Finalizes funding as canceled (< 2/3 cap)", async () => {
      // Wait for funding period to end (3 seconds)
      const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
      await sleep(3000);

      await program.methods
        .finalizeFunding()
        .accounts({
          vault: vaultPda,
          vaultTokenAccount: vaultTokenAccount,
          authorityTokenAccount: authorityTokenAccount,
          authority: authority.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();

      const vault = await program.account.vault.fetch(vaultPda);
      assert.deepEqual(vault.status, { canceled: {} }); // Canceled

      // Verify funds remain in vault
      const vaultAccount = await getAccount(provider.connection, vaultTokenAccount);
      assert.equal(vaultAccount.amount.toString(), "600000000000");
    });

    it("User 1 claims full refund", async () => {
      const balanceBefore = await getAccount(provider.connection, user1TokenAccount);

      await program.methods
        .claim()
        .accounts({
          vault: vaultPda,
          vaultTokenAccount: vaultTokenAccount,
          position: user1Position,
          userTokenAccount: user1TokenAccount,
          user: user1.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([user1])
        .rpc();

      const balanceAfter = await getAccount(provider.connection, user1TokenAccount);
      assert.equal(
        (balanceAfter.amount - balanceBefore.amount).toString(),
        "600000000000"
      );
    });
  });

  describe("Edge Cases", () => {
    const vaultId = new BN(3);
    let vaultPda: PublicKey;
    let vaultTokenAccount: PublicKey;

    it("Fails to deposit below minimum", async () => {
      [vaultPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("vault"),
          authority.publicKey.toBuffer(),
          vaultId.toArrayLike(Buffer, "le", 8),
        ],
        program.programId
      );

      [vaultTokenAccount] = PublicKey.findProgramAddressSync(
        [Buffer.from("vault_token"), vaultPda.toBuffer()],
        program.programId
      );

      const cap = new BN(1000_000_000_000);
      const targetApyBps = 1200;
      const fundingEndTs = new BN(Math.floor(Date.now() / 1000) + 3600); // 1 hour (still in funding)
      const maturityTs = new BN(Math.floor(Date.now() / 1000) + 7200);
      const minDeposit = new BN(10_000_000_000);

      await program.methods
        .initializeVault(vaultId, cap, targetApyBps, fundingEndTs, maturityTs, minDeposit)
        .accounts({
          vault: vaultPda,
          vaultTokenAccount: vaultTokenAccount,
          assetMint: mint,
          authority: authority.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .rpc();

      const [user1Position] = PublicKey.findProgramAddressSync(
        [Buffer.from("position"), vaultPda.toBuffer(), user1.publicKey.toBuffer()],
        program.programId
      );

      try {
        await program.methods
          .deposit(new BN(5_000_000_000)) // 5 tokens, below min 10
          .accounts({
            vault: vaultPda,
            vaultTokenAccount: vaultTokenAccount,
            position: user1Position,
            userTokenAccount: user1TokenAccount,
            user: user1.publicKey,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([user1])
          .rpc();
        assert.fail("Should have failed with BelowMinDeposit");
      } catch (err) {
        assert.include(err.toString(), "BelowMinDeposit");
      }
    });

    it("Fails to deposit exceeding cap", async () => {
      const [user1Position] = PublicKey.findProgramAddressSync(
        [Buffer.from("position"), vaultPda.toBuffer(), user1.publicKey.toBuffer()],
        program.programId
      );

      try {
        await program.methods
          .deposit(new BN(1001_000_000_000)) // Exceeds 1000 cap
          .accounts({
            vault: vaultPda,
            vaultTokenAccount: vaultTokenAccount,
            position: user1Position,
            userTokenAccount: user1TokenAccount,
            user: user1.publicKey,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([user1])
          .rpc();
        assert.fail("Should have failed with CapExceeded");
      } catch (err) {
        assert.include(err.toString(), "CapExceeded");
      }
    });
  });
});
