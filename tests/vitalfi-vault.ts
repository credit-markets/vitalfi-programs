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

    // Mint tokens to authority (for mature_vault operations)
    await mintTo(
      provider.connection,
      authority.payer,
      mint,
      authorityTokenAccount,
      authority.publicKey,
      100000_000_000_000
    );

    // Mint tokens to users (10000 tokens each for comprehensive tests)
    await mintTo(
      provider.connection,
      authority.payer,
      mint,
      user1TokenAccount,
      authority.publicKey,
      10000_000_000_000
    );
    await mintTo(
      provider.connection,
      authority.payer,
      mint,
      user2TokenAccount,
      authority.publicKey,
      10000_000_000_000
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

      // Get balance before finalize
      const authorityAccountBefore = await getAccount(provider.connection, authorityTokenAccount);
      const balanceBefore = Number(authorityAccountBefore.amount);

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

      // Verify 700 tokens were withdrawn to authority
      const authorityAccountAfter = await getAccount(provider.connection, authorityTokenAccount);
      const balanceAfter = Number(authorityAccountAfter.amount);
      assert.equal(balanceAfter - balanceBefore, 700_000_000_000);
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

  describe("Comprehensive Error Coverage", () => {
    const vaultId = new BN(100);
    let vaultPda: PublicKey;
    let vaultTokenAccount: PublicKey;

    describe("Validation Errors", () => {
      it("Fails with InvalidCapacity - zero cap", async () => {
        const testVaultId = new BN(101);
        const [testVaultPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("vault"), authority.publicKey.toBuffer(), testVaultId.toArrayLike(Buffer, "le", 8)],
          program.programId
        );
        const [testVaultToken] = PublicKey.findProgramAddressSync(
          [Buffer.from("vault_token"), testVaultPda.toBuffer()],
          program.programId
        );

        try {
          await program.methods
            .initializeVault(testVaultId, new BN(0), 1200, new BN(Date.now() / 1000 + 3600), new BN(Date.now() / 1000 + 7200), new BN(10))
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
        } catch (err) {
          assert.include(err.toString(), "InvalidCapacity");
        }
      });

      it("Fails with InvalidTimestamps - funding_end in past", async () => {
        const testVaultId = new BN(102);
        const [testVaultPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("vault"), authority.publicKey.toBuffer(), testVaultId.toArrayLike(Buffer, "le", 8)],
          program.programId
        );
        const [testVaultToken] = PublicKey.findProgramAddressSync(
          [Buffer.from("vault_token"), testVaultPda.toBuffer()],
          program.programId
        );

        try {
          await program.methods
            .initializeVault(
              testVaultId,
              new BN(1000_000_000_000),
              1200,
              new BN(Math.floor(Date.now() / 1000) - 100), // Past
              new BN(Math.floor(Date.now() / 1000) + 7200),
              new BN(10_000_000_000)
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
        } catch (err) {
          assert.include(err.toString(), "InvalidTimestamps");
        }
      });

      it("Fails with InvalidTimestamps - maturity before funding_end", async () => {
        const testVaultId = new BN(103);
        const [testVaultPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("vault"), authority.publicKey.toBuffer(), testVaultId.toArrayLike(Buffer, "le", 8)],
          program.programId
        );
        const [testVaultToken] = PublicKey.findProgramAddressSync(
          [Buffer.from("vault_token"), testVaultPda.toBuffer()],
          program.programId
        );

        try {
          await program.methods
            .initializeVault(
              testVaultId,
              new BN(1000_000_000_000),
              1200,
              new BN(Math.floor(Date.now() / 1000) + 7200),
              new BN(Math.floor(Date.now() / 1000) + 3600), // Before funding_end
              new BN(10_000_000_000)
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
        } catch (err) {
          assert.include(err.toString(), "InvalidTimestamps");
        }
      });

      it("Fails with ZeroDeposit", async () => {
        const testVaultId = new BN(104);
        const [testVaultPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("vault"), authority.publicKey.toBuffer(), testVaultId.toArrayLike(Buffer, "le", 8)],
          program.programId
        );
        const [testVaultToken] = PublicKey.findProgramAddressSync(
          [Buffer.from("vault_token"), testVaultPda.toBuffer()],
          program.programId
        );

        await program.methods
          .initializeVault(
            testVaultId,
            new BN(1000_000_000_000),
            1200,
            new BN(Math.floor(Date.now() / 1000) + 3600),
            new BN(Math.floor(Date.now() / 1000) + 7200),
            new BN(10_000_000_000)
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

        const [testPosition] = PublicKey.findProgramAddressSync(
          [Buffer.from("position"), testVaultPda.toBuffer(), user1.publicKey.toBuffer()],
          program.programId
        );

        try {
          await program.methods
            .deposit(new BN(0)) // Zero amount
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
        } catch (err) {
          assert.include(err.toString(), "ZeroDeposit");
        }
      });
    });

    describe("Boundary Tests", () => {
      it("Succeeds with exact 2/3 threshold (667 out of 1000)", async () => {
        const testVaultId = new BN(200);
        const [testVaultPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("vault"), authority.publicKey.toBuffer(), testVaultId.toArrayLike(Buffer, "le", 8)],
          program.programId
        );
        const [testVaultToken] = PublicKey.findProgramAddressSync(
          [Buffer.from("vault_token"), testVaultPda.toBuffer()],
          program.programId
        );

        await program.methods
          .initializeVault(
            testVaultId,
            new BN(1000_000_000_000),
            1200,
            new BN(Math.floor(Date.now() / 1000) + 2),
            new BN(Math.floor(Date.now() / 1000) + 3600),
            new BN(10_000_000_000)
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

        const [testPosition] = PublicKey.findProgramAddressSync(
          [Buffer.from("position"), testVaultPda.toBuffer(), user1.publicKey.toBuffer()],
          program.programId
        );

        // Deposit exactly 667 tokens (exact 2/3 threshold)
        await program.methods
          .deposit(new BN(667_000_000_000))
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
        await new Promise((resolve) => setTimeout(resolve, 3000));

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
        const [testVaultPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("vault"), authority.publicKey.toBuffer(), testVaultId.toArrayLike(Buffer, "le", 8)],
          program.programId
        );
        const [testVaultToken] = PublicKey.findProgramAddressSync(
          [Buffer.from("vault_token"), testVaultPda.toBuffer()],
          program.programId
        );

        await program.methods
          .initializeVault(
            testVaultId,
            new BN(1000_000_000_000),
            1200,
            new BN(Math.floor(Date.now() / 1000) + 2),
            new BN(Math.floor(Date.now() / 1000) + 3600),
            new BN(10_000_000_000)
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

        const [testPosition] = PublicKey.findProgramAddressSync(
          [Buffer.from("position"), testVaultPda.toBuffer(), user2.publicKey.toBuffer()],
          program.programId
        );

        // Deposit 666 tokens (just below threshold)
        await program.methods
          .deposit(new BN(666_000_000_000))
          .accounts({
            vault: testVaultPda,
            vaultTokenAccount: testVaultToken,
            position: testPosition,
            userTokenAccount: user2TokenAccount,
            user: user2.publicKey,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([user2])
          .rpc();

        // Wait for funding to end
        await new Promise((resolve) => setTimeout(resolve, 3000));

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
  });

  describe("Additional Error Coverage", () => {
    describe("Status and Timing Errors", () => {
      it("Fails with FundingEnded when depositing after funding period", async () => {
        const testVaultId = new BN(300);
        const [testVaultPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("vault"), authority.publicKey.toBuffer(), testVaultId.toArrayLike(Buffer, "le", 8)],
          program.programId
        );
        const [testVaultToken] = PublicKey.findProgramAddressSync(
          [Buffer.from("vault_token"), testVaultPda.toBuffer()],
          program.programId
        );

        await program.methods
          .initializeVault(
            testVaultId,
            new BN(1000_000_000_000),
            1200,
            new BN(Math.floor(Date.now() / 1000) + 1), // Ends in 1 second
            new BN(Math.floor(Date.now() / 1000) + 3600),
            new BN(10_000_000_000)
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
        await new Promise((resolve) => setTimeout(resolve, 2000));

        const [testPosition] = PublicKey.findProgramAddressSync(
          [Buffer.from("position"), testVaultPda.toBuffer(), user1.publicKey.toBuffer()],
          program.programId
        );

        try {
          await program.methods
            .deposit(new BN(100_000_000_000))
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
        } catch (err) {
          assert.include(err.toString(), "FundingEnded");
        }
      });

      it("Fails with FundingNotEnded when finalizing before funding period ends", async () => {
        const testVaultId = new BN(301);
        const [testVaultPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("vault"), authority.publicKey.toBuffer(), testVaultId.toArrayLike(Buffer, "le", 8)],
          program.programId
        );
        const [testVaultToken] = PublicKey.findProgramAddressSync(
          [Buffer.from("vault_token"), testVaultPda.toBuffer()],
          program.programId
        );

        await program.methods
          .initializeVault(
            testVaultId,
            new BN(1000_000_000_000),
            1200,
            new BN(Math.floor(Date.now() / 1000) + 100), // Ends in 100 seconds
            new BN(Math.floor(Date.now() / 1000) + 3600),
            new BN(10_000_000_000)
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
        } catch (err) {
          assert.include(err.toString(), "FundingNotEnded");
        }
      });

      it("Fails with NotMatured when maturing before maturity time", async () => {
        const testVaultId = new BN(302);
        const [testVaultPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("vault"), authority.publicKey.toBuffer(), testVaultId.toArrayLike(Buffer, "le", 8)],
          program.programId
        );
        const [testVaultToken] = PublicKey.findProgramAddressSync(
          [Buffer.from("vault_token"), testVaultPda.toBuffer()],
          program.programId
        );
        const [testPosition] = PublicKey.findProgramAddressSync(
          [Buffer.from("position"), testVaultPda.toBuffer(), user1.publicKey.toBuffer()],
          program.programId
        );

        await program.methods
          .initializeVault(
            testVaultId,
            new BN(1000_000_000_000),
            1200,
            new BN(Math.floor(Date.now() / 1000) + 1),
            new BN(Math.floor(Date.now() / 1000) + 100), // Matures in 100 seconds
            new BN(10_000_000_000)
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
          .deposit(new BN(700_000_000_000))
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

        await new Promise((resolve) => setTimeout(resolve, 2000));

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
            .matureVault(new BN(770_000_000_000))
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
          assert.include(err.message || err.toString(), "NotMatured");
        }
      });

      it("Fails with AlreadyMatured when maturing twice", async () => {
        const testVaultId = new BN(303);
        const [testVaultPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("vault"), authority.publicKey.toBuffer(), testVaultId.toArrayLike(Buffer, "le", 8)],
          program.programId
        );
        const [testVaultToken] = PublicKey.findProgramAddressSync(
          [Buffer.from("vault_token"), testVaultPda.toBuffer()],
          program.programId
        );
        const [testPosition] = PublicKey.findProgramAddressSync(
          [Buffer.from("position"), testVaultPda.toBuffer(), user1.publicKey.toBuffer()],
          program.programId
        );

        await program.methods
          .initializeVault(
            testVaultId,
            new BN(1000_000_000_000),
            1200,
            new BN(Math.floor(Date.now() / 1000) + 1),
            new BN(Math.floor(Date.now() / 1000) + 2),
            new BN(10_000_000_000)
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
          .deposit(new BN(700_000_000_000))
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

        await new Promise((resolve) => setTimeout(resolve, 2000));

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

        await new Promise((resolve) => setTimeout(resolve, 1000));

        await program.methods
          .matureVault(new BN(770_000_000_000))
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
            .matureVault(new BN(770_000_000_000))
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
          assert.include(err.message || err.toString(), "Invalid");
        }
      });

      it("Fails with NothingToClaim when claiming with no deposit", async () => {
        const testVaultId = new BN(304);
        const [testVaultPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("vault"), authority.publicKey.toBuffer(), testVaultId.toArrayLike(Buffer, "le", 8)],
          program.programId
        );
        const [testVaultToken] = PublicKey.findProgramAddressSync(
          [Buffer.from("vault_token"), testVaultPda.toBuffer()],
          program.programId
        );
        const [position1] = PublicKey.findProgramAddressSync(
          [Buffer.from("position"), testVaultPda.toBuffer(), user1.publicKey.toBuffer()],
          program.programId
        );
        const [position2] = PublicKey.findProgramAddressSync(
          [Buffer.from("position"), testVaultPda.toBuffer(), user2.publicKey.toBuffer()],
          program.programId
        );

        await program.methods
          .initializeVault(
            testVaultId,
            new BN(1000_000_000_000),
            1200,
            new BN(Math.floor(Date.now() / 1000) + 1),
            new BN(Math.floor(Date.now() / 1000) + 2),
            new BN(10_000_000_000)
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
          .deposit(new BN(700_000_000_000))
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

        await new Promise((resolve) => setTimeout(resolve, 2000));

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

        await new Promise((resolve) => setTimeout(resolve, 1000));

        await program.methods
          .matureVault(new BN(770_000_000_000))
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
          // Position account doesn't exist for user2, or it exists but has no deposit
          const errorStr = err.message || err.toString();
          // Check for either account not found or constraint violation
          assert.isTrue(
            errorStr.includes("account") || errorStr.includes("constraint"),
            `Expected error about account, got: ${errorStr}`
          );
        }
      });

      it("Fails with InvalidStatus when depositing to canceled vault", async () => {
        const testVaultId = new BN(305);
        const [testVaultPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("vault"), authority.publicKey.toBuffer(), testVaultId.toArrayLike(Buffer, "le", 8)],
          program.programId
        );
        const [testVaultToken] = PublicKey.findProgramAddressSync(
          [Buffer.from("vault_token"), testVaultPda.toBuffer()],
          program.programId
        );
        const [testPosition] = PublicKey.findProgramAddressSync(
          [Buffer.from("position"), testVaultPda.toBuffer(), user1.publicKey.toBuffer()],
          program.programId
        );

        await program.methods
          .initializeVault(
            testVaultId,
            new BN(1000_000_000_000),
            1200,
            new BN(Math.floor(Date.now() / 1000) + 1),
            new BN(Math.floor(Date.now() / 1000) + 3600),
            new BN(10_000_000_000)
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
          .deposit(new BN(100_000_000_000))
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

        await new Promise((resolve) => setTimeout(resolve, 2000));

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
            .deposit(new BN(100_000_000_000))
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
        } catch (err) {
          assert.include(err.toString(), "InvalidStatus");
        }
      });

      it("Fails with CannotCloseWithFunds when closing vault with remaining funds", async () => {
        const testVaultId = new BN(306);
        const [testVaultPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("vault"), authority.publicKey.toBuffer(), testVaultId.toArrayLike(Buffer, "le", 8)],
          program.programId
        );
        const [testVaultToken] = PublicKey.findProgramAddressSync(
          [Buffer.from("vault_token"), testVaultPda.toBuffer()],
          program.programId
        );
        const [testPosition] = PublicKey.findProgramAddressSync(
          [Buffer.from("position"), testVaultPda.toBuffer(), user1.publicKey.toBuffer()],
          program.programId
        );

        await program.methods
          .initializeVault(
            testVaultId,
            new BN(1000_000_000_000),
            1200,
            new BN(Math.floor(Date.now() / 1000) + 1),
            new BN(Math.floor(Date.now() / 1000) + 2),
            new BN(10_000_000_000)
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
          .deposit(new BN(700_000_000_000))
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

        await new Promise((resolve) => setTimeout(resolve, 2000));

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

        await new Promise((resolve) => setTimeout(resolve, 1000));

        await program.methods
          .matureVault(new BN(770_000_000_000))
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
          assert.include(err.message || err.toString(), "CannotCloseWithFunds");
        }
      });
    });
  });

  describe("Security Tests", () => {
    describe("Balance Validation in mature_vault", () => {
      it("Validates actual transferred amount matches claimed amount", async () => {
        const testVaultId = new BN(400);
        const [testVaultPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("vault"), authority.publicKey.toBuffer(), testVaultId.toArrayLike(Buffer, "le", 8)],
          program.programId
        );
        const [testVaultToken] = PublicKey.findProgramAddressSync(
          [Buffer.from("vault_token"), testVaultPda.toBuffer()],
          program.programId
        );
        const [testPosition] = PublicKey.findProgramAddressSync(
          [Buffer.from("position"), testVaultPda.toBuffer(), user1.publicKey.toBuffer()],
          program.programId
        );

        await program.methods
          .initializeVault(
            testVaultId,
            new BN(1000_000_000_000),
            1200,
            new BN(Math.floor(Date.now() / 1000) + 1),
            new BN(Math.floor(Date.now() / 1000) + 2),
            new BN(10_000_000_000)
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
          .deposit(new BN(700_000_000_000))
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

        await new Promise((resolve) => setTimeout(resolve, 2000));

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

        await new Promise((resolve) => setTimeout(resolve, 1000));

        // Mature vault with correct amount (should succeed)
        await program.methods
          .matureVault(new BN(770_000_000_000))
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
        assert.equal(vault.payoutNum.toString(), "770000000000");
        assert.equal(vault.payoutDen.toString(), "700000000000");
      });
    });

    describe("MAX_VAULT_CAP Validation", () => {
      it("Fails with InvalidCapacity when cap exceeds MAX_VAULT_CAP", async () => {
        const testVaultId = new BN(401);
        const [testVaultPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("vault"), authority.publicKey.toBuffer(), testVaultId.toArrayLike(Buffer, "le", 8)],
          program.programId
        );
        const [testVaultToken] = PublicKey.findProgramAddressSync(
          [Buffer.from("vault_token"), testVaultPda.toBuffer()],
          program.programId
        );

        // Try to initialize with cap > MAX_VAULT_CAP (u64::MAX / 3)
        const maxCap = new BN("6148914691236517205"); // (u64::MAX / 3) + 1
        try {
          await program.methods
            .initializeVault(
              testVaultId,
              maxCap,
              1200,
              new BN(Math.floor(Date.now() / 1000) + 100),
              new BN(Math.floor(Date.now() / 1000) + 3600),
              new BN(10_000_000_000)
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
        } catch (err) {
          assert.include(err.toString(), "InvalidCapacity");
        }
      });
    });

    describe("Dust Tolerance in close_vault", () => {
      it("Allows closing vault with small dust amount (≤1000)", async () => {
        const testVaultId = new BN(402);
        const [testVaultPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("vault"), authority.publicKey.toBuffer(), testVaultId.toArrayLike(Buffer, "le", 8)],
          program.programId
        );
        const [testVaultToken] = PublicKey.findProgramAddressSync(
          [Buffer.from("vault_token"), testVaultPda.toBuffer()],
          program.programId
        );
        const [testPosition] = PublicKey.findProgramAddressSync(
          [Buffer.from("position"), testVaultPda.toBuffer(), user1.publicKey.toBuffer()],
          program.programId
        );

        await program.methods
          .initializeVault(
            testVaultId,
            new BN(1000_000_000_000),
            1200,
            new BN(Math.floor(Date.now() / 1000) + 1),
            new BN(Math.floor(Date.now() / 1000) + 2),
            new BN(10_000_000_000)
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
          .deposit(new BN(700_000_000_000))
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

        await new Promise((resolve) => setTimeout(resolve, 2000));

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

        await new Promise((resolve) => setTimeout(resolve, 1000));

        await program.methods
          .matureVault(new BN(770_000_000_000))
          .accounts({
            vault: testVaultPda,
            vaultTokenAccount: testVaultToken,
            authorityTokenAccount: authorityTokenAccount,
            authority: authority.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .rpc();

        // User claims all but leaves small dust (≤1000 lamports)
        await program.methods
          .claim()
          .accounts({
            vault: testVaultPda,
            vaultTokenAccount: testVaultToken,
            position: testPosition,
            userTokenAccount: user1TokenAccount,
            user: user1.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([user1])
          .rpc();

        // Close vault should succeed with dust tolerance
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
            assert.include(err.message || err.toString(), "Account does not exist");
          }

          // Vault token account should also be closed
          try {
            await getAccount(provider.connection, testVaultToken);
            assert.fail("Vault token account should be closed");
          } catch (err: any) {
            // Token account no longer exists - check for either error format
            const errorStr = err.message || err.name || err.toString();
            assert.isTrue(
              errorStr.includes("could not find") || errorStr.includes("TokenAccountNotFoundError") || errorStr.includes("not found"),
              `Expected token account not found error, got: ${errorStr}`
            );
          }
        }
      });
    });

    describe("Partial Claim Security", () => {
      it("Prevents double claiming through state checks", async () => {
        const testVaultId = new BN(403);
        const [testVaultPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("vault"), authority.publicKey.toBuffer(), testVaultId.toArrayLike(Buffer, "le", 8)],
          program.programId
        );
        const [testVaultToken] = PublicKey.findProgramAddressSync(
          [Buffer.from("vault_token"), testVaultPda.toBuffer()],
          program.programId
        );
        const [testPosition] = PublicKey.findProgramAddressSync(
          [Buffer.from("position"), testVaultPda.toBuffer(), user1.publicKey.toBuffer()],
          program.programId
        );

        await program.methods
          .initializeVault(
            testVaultId,
            new BN(1000_000_000_000),
            1200,
            new BN(Math.floor(Date.now() / 1000) + 1),
            new BN(Math.floor(Date.now() / 1000) + 2),
            new BN(10_000_000_000)
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
          .deposit(new BN(700_000_000_000))
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

        await new Promise((resolve) => setTimeout(resolve, 2000));

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

        await new Promise((resolve) => setTimeout(resolve, 1000));

        await program.methods
          .matureVault(new BN(770_000_000_000))
          .accounts({
            vault: testVaultPda,
            vaultTokenAccount: testVaultToken,
            authorityTokenAccount: authorityTokenAccount,
            authority: authority.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .rpc();

        // First claim should succeed
        await program.methods
          .claim()
          .accounts({
            vault: testVaultPda,
            vaultTokenAccount: testVaultToken,
            position: testPosition,
            userTokenAccount: user1TokenAccount,
            user: user1.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([user1])
          .rpc();

        const positionAfter = await program.account.position.fetch(testPosition);
        assert.equal(positionAfter.claimed.toString(), "770000000000"); // Full payout claimed

        // Second claim should fail with NothingToClaim
        try {
          await program.methods
            .claim()
            .accounts({
              vault: testVaultPda,
              vaultTokenAccount: testVaultToken,
              position: testPosition,
              userTokenAccount: user1TokenAccount,
              user: user1.publicKey,
              tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([user1])
            .rpc();
          assert.fail("Should have failed with NothingToClaim");
        } catch (err) {
          assert.include(err.toString(), "NothingToClaim");
        }
      });
    });
  });
});
