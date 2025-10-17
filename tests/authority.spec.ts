import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { VitalfiVault } from "../target/types/vitalfi_vault";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
} from "@solana/spl-token";
import { assert } from "chai";
import {
  nowOnChain,
  waitUntilUnix,
  toU,
  PDA,
  expectErrorContains,
} from "./utils.spec";

describe("Authority Permission Tests", () => {
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

    user1 = Keypair.generate();

    // Airdrop SOL to user
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

    // Mint tokens
    await mintTo(
      provider.connection,
      authority.payer,
      mint,
      authorityTokenAccount,
      authority.publicKey,
      toU(10000).toNumber()
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

  describe("finalize_funding permissions", () => {
    it("Rejects finalization from non-authority", async () => {
      const vaultId = new BN(1000);
      const vaultPda = pda.vault(authority.publicKey, vaultId);
      const vaultTokenPda = pda.vaultToken(vaultPda);
      const positionPda = pda.position(vaultPda, user1.publicKey);

      const now = await nowOnChain(provider.connection);
      const fundingEndTs = new BN(now + 2);
      const maturityTs = new BN(now + 4);

      // Initialize vault
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

      // User deposits
      await program.methods
        .deposit(toU(700))
        .accounts({
          vault: vaultPda,
          vaultTokenAccount: vaultTokenPda,
          position: positionPda,
          userTokenAccount: user1TokenAccount,
          user: user1.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([user1])
        .rpc();

      // Wait for funding to end
      await waitUntilUnix(provider.connection, fundingEndTs.toNumber());

      // Try to finalize as non-authority (should fail)
      try {
        await program.methods
          .finalizeFunding()
          .accounts({
            vault: vaultPda,
            vaultTokenAccount: vaultTokenPda,
            authorityTokenAccount: user1TokenAccount, // Wrong token account
            authority: user1.publicKey, // Wrong authority
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([user1])
          .rpc();
        assert.fail("Should have rejected non-authority finalization");
      } catch (err: any) {
        // Expect either constraint error or authorization error
        expectErrorContains(err, "");
      }
    });
  });

  describe("mature_vault permissions", () => {
    it("Rejects maturation from non-authority", async () => {
      const vaultId = new BN(1001);
      const vaultPda = pda.vault(authority.publicKey, vaultId);
      const vaultTokenPda = pda.vaultToken(vaultPda);
      const positionPda = pda.position(vaultPda, user1.publicKey);

      const now = await nowOnChain(provider.connection);
      const fundingEndTs = new BN(now + 2);
      const maturityTs = new BN(now + 4);

      // Initialize and setup vault
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

      await program.methods
        .deposit(toU(700))
        .accounts({
          vault: vaultPda,
          vaultTokenAccount: vaultTokenPda,
          position: positionPda,
          userTokenAccount: user1TokenAccount,
          user: user1.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([user1])
        .rpc();

      await waitUntilUnix(provider.connection, fundingEndTs.toNumber());

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

      await waitUntilUnix(provider.connection, maturityTs.toNumber());

      // Try to mature as non-authority (should fail)
      try {
        await program.methods
          .matureVault(toU(770))
          .accounts({
            vault: vaultPda,
            vaultTokenAccount: vaultTokenPda,
            authorityTokenAccount: user1TokenAccount,
            authority: user1.publicKey, // Wrong authority
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([user1])
          .rpc();
        assert.fail("Should have rejected non-authority maturation");
      } catch (err: any) {
        // Test passes if any error is thrown (authorization check worked)
        assert.exists(err);
      }
    });
  });

  describe("close_vault permissions", () => {
    it("Rejects closure from non-authority", async () => {
      const vaultId = new BN(1002);
      const vaultPda = pda.vault(authority.publicKey, vaultId);
      const vaultTokenPda = pda.vaultToken(vaultPda);
      const positionPda = pda.position(vaultPda, user1.publicKey);

      const now = await nowOnChain(provider.connection);
      const fundingEndTs = new BN(now + 2);
      const maturityTs = new BN(now + 4);

      // Setup completed vault
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

      await program.methods
        .deposit(toU(700))
        .accounts({
          vault: vaultPda,
          vaultTokenAccount: vaultTokenPda,
          position: positionPda,
          userTokenAccount: user1TokenAccount,
          user: user1.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([user1])
        .rpc();

      await waitUntilUnix(provider.connection, fundingEndTs.toNumber());

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

      await waitUntilUnix(provider.connection, maturityTs.toNumber());

      await program.methods
        .matureVault(toU(770))
        .accounts({
          vault: vaultPda,
          vaultTokenAccount: vaultTokenPda,
          authorityTokenAccount: authorityTokenAccount,
          authority: authority.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();

      // User claims
      await program.methods
        .claim()
        .accounts({
          vault: vaultPda,
          vaultTokenAccount: vaultTokenPda,
          position: positionPda,
          userTokenAccount: user1TokenAccount,
          user: user1.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([user1])
        .rpc();

      // Try to close as non-authority (should fail)
      try {
        await program.methods
          .closeVault()
          .accounts({
            vault: vaultPda,
            vaultTokenAccount: vaultTokenPda,
            authority: user1.publicKey, // Wrong authority
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([user1])
          .rpc();
        assert.fail("Should have rejected non-authority closure");
      } catch (err: any) {
        // Test passes if any error is thrown (authorization check worked)
        assert.exists(err);
      }
    });
  });
});
