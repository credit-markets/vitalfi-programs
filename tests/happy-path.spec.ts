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
  expectErrorContains,
} from "./utils.spec";

describe("Vault Close Happy Path", () => {
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

  it("Successfully closes vault after all users claim", async () => {
    const vaultId = new BN(500);
    const vaultPda = pda.vault(authority.publicKey, vaultId);
    const vaultTokenPda = pda.vaultToken(vaultPda);
    const positionPda = pda.position(vaultPda, user1.publicKey);

    // Use on-chain time for reliable testing
    const now = await nowOnChain(provider.connection);
    const fundingEndTs = new BN(now + 2);
    const maturityTs = new BN(now + 4);

    const cap = toU(1000);
    const depositAmount = toU(700);
    const returnAmount = toU(770); // 110% return

    // 1. Initialize vault
    await program.methods
      .initializeVault(vaultId, cap, 1200, fundingEndTs, maturityTs, toU(10))
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

    // 2. User deposits
    await program.methods
      .deposit(depositAmount)
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

    // 3. Wait for funding period to end
    await waitUntilUnix(provider.connection, fundingEndTs.toNumber());

    // 4. Finalize funding
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

    const vault = await program.account.vault.fetch(vaultPda);
    assert.deepEqual(vault.status, { active: {} });

    // 5. Wait for maturity
    await waitUntilUnix(provider.connection, maturityTs.toNumber());

    // 6. Mature vault with returns
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

    const vaultAfterMature = await program.account.vault.fetch(vaultPda);
    assert.deepEqual(vaultAfterMature.status, { matured: {} });

    // 7. User claims all payout
    const balanceBefore = await getAccount(provider.connection, user1TokenAccount);

    await program.methods
      .claim()
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

    const balanceAfter = await getAccount(provider.connection, user1TokenAccount);
    const expectedPayout = toU(770); // 700 * 770 / 700 = 770
    assertBNEqual(
      new BN(balanceAfter.amount.toString()).sub(new BN(balanceBefore.amount.toString())),
      expectedPayout,
      "User should receive expected payout"
    );

    // 8. Verify vault token account is empty or has negligible dust
    const vaultTokenAccount = await getAccount(provider.connection, vaultTokenPda);
    const remainingBalance = new BN(vaultTokenAccount.amount.toString());
    assert.isTrue(
      remainingBalance.lten(1000),
      `Vault should be empty or have dust, has ${remainingBalance.toString()}`
    );

    // 9. Close vault (should succeed)
    await program.methods
      .closeVault()
      .accounts({
        vault: vaultPda,
        vaultTokenAccount: vaultTokenPda,
        authority: authority.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    // 10. Verify vault account is closed
    try {
      await program.account.vault.fetch(vaultPda);
      assert.fail("Vault should be closed");
    } catch (err: any) {
      expectErrorContains(err, "Account does not exist");
    }

    // 11. Verify vault token account is closed
    try {
      await getAccount(provider.connection, vaultTokenPda);
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
  });

  it("Successfully closes canceled vault after refunds", async () => {
    const vaultId = new BN(501);
    const vaultPda = pda.vault(authority.publicKey, vaultId);
    const vaultTokenPda = pda.vaultToken(vaultPda);
    const positionPda = pda.position(vaultPda, user1.publicKey);

    const now = await nowOnChain(provider.connection);
    const fundingEndTs = new BN(now + 2);
    const maturityTs = new BN(now + 4);

    const cap = toU(1000);
    const depositAmount = toU(600); // Below 2/3 threshold

    // Initialize vault
    await program.methods
      .initializeVault(vaultId, cap, 1200, fundingEndTs, maturityTs, toU(10))
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

    // User deposits (below threshold)
    await program.methods
      .deposit(depositAmount)
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

    // Wait and finalize as canceled
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

    const vault = await program.account.vault.fetch(vaultPda);
    assert.deepEqual(vault.status, { canceled: {} });

    // User claims refund
    await program.methods
      .claim()
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

    // Close vault
    await program.methods
      .closeVault()
      .accounts({
        vault: vaultPda,
        vaultTokenAccount: vaultTokenPda,
        authority: authority.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    // Verify both accounts are closed
    try {
      await program.account.vault.fetch(vaultPda);
      assert.fail("Vault should be closed");
    } catch (err: any) {
      expectErrorContains(err, "Account does not exist");
    }

    try {
      await getAccount(provider.connection, vaultTokenPda);
      assert.fail("Vault token account should be closed");
    } catch (err: any) {
      // Success - account not found
    }
  });
});
