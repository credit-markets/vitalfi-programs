//! # VitalFi Vault Program Instructions
//!
//! This module contains all instruction handlers for the multi-vault crowdfunding system.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::errors::*;
use crate::events::*;
use crate::state::*;

/// Maximum vault capacity to prevent overflow in 2/3 threshold calculation.
/// Set to u64::MAX / 3 to ensure (cap * 2 + 2) fits in u128.
pub const MAX_VAULT_CAP: u64 = u64::MAX / 3;

/// Maximum dust amount allowed in vault when closing (1000 smallest units = 0.000001 for 9 decimals).
pub const MAX_DUST_AMOUNT: u64 = 1000;

// ============================================
// Initialize Vault Instruction
// ============================================

/// Accounts required for vault initialization.
///
/// # Security Considerations
/// - Vault PDA ensures unique vault per authority+vault_id combination
/// - Vault token account PDA ensures vault has exclusive control over funds
/// - Authority pays for account creation (payer)
#[derive(Accounts)]
#[instruction(vault_id: u64)]
pub struct InitializeVault<'info> {
    /// Vault PDA account to be initialized.
    ///
    /// **Seeds:** `["vault", authority, vault_id]`
    ///
    /// This PDA pattern allows one authority to create multiple vaults with unique IDs.
    #[account(
        init,
        payer = authority,
        space = Vault::LEN,
        seeds = [b"vault", authority.key().as_ref(), vault_id.to_le_bytes().as_ref()],
        bump
    )]
    pub vault: Account<'info, Vault>,

    /// Token account owned by the vault PDA to hold user deposits.
    ///
    /// **Seeds:** `["vault_token", vault]`
    /// **Authority:** The vault PDA itself
    ///
    /// Only the vault PDA can sign for transfers from this account,
    /// preventing unauthorized withdrawals.
    #[account(
        init,
        payer = authority,
        seeds = [b"vault_token", vault.key().as_ref()],
        bump,
        token::mint = asset_mint,
        token::authority = vault,
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    /// SPL token mint that this vault will accept (e.g., USDC, wSOL).
    pub asset_mint: Account<'info, Mint>,

    /// Vault creator and operator. Must sign and pay for account creation.
    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

/// Initializes a new vault with funding parameters.
///
/// Validates: cap > 0, min_deposit > 0, min_deposit <= cap, now < funding_end < maturity.
/// Creates vault in Funding status with PDA-owned token account.
pub fn initialize_vault(
    ctx: Context<InitializeVault>,
    vault_id: u64,
    cap: u64,
    target_apy_bps: u32,
    funding_end_ts: i64,
    maturity_ts: i64,
    min_deposit: u64,
) -> Result<()> {
    let clock = Clock::get()?;
    let vault = &mut ctx.accounts.vault;

    // Validate parameters to prevent misconfiguration
    require!(cap > 0, VaultError::InvalidCapacity);
    require!(cap <= MAX_VAULT_CAP, VaultError::InvalidCapacity);
    require!(min_deposit > 0, VaultError::InvalidMinDeposit);
    require!(min_deposit <= cap, VaultError::InvalidMinDeposit);

    // Validate timestamp ordering: now < funding_end < maturity
    require!(
        funding_end_ts > clock.unix_timestamp,
        VaultError::InvalidTimestamps
    );
    require!(maturity_ts > funding_end_ts, VaultError::InvalidTimestamps);

    // Initialize vault
    vault.version = 1;
    vault.authority = ctx.accounts.authority.key();
    vault.vault_id = vault_id;
    vault.asset_mint = ctx.accounts.asset_mint.key();
    vault.vault_token = ctx.accounts.vault_token_account.key();
    vault.cap = cap;
    vault.target_apy_bps = target_apy_bps;
    vault.funding_end_ts = funding_end_ts;
    vault.maturity_ts = maturity_ts;
    vault.min_deposit = min_deposit;
    vault.status = VaultStatus::Funding;
    vault.total_deposited = 0;
    vault.total_claimed = 0;
    vault.payout_num = 0;
    vault.payout_den = 0;
    vault.bump = ctx.bumps.vault;

    emit!(VaultCreated {
        vault: vault.key(),
        authority: vault.authority,
        vault_id,
        asset_mint: vault.asset_mint,
        cap,
        target_apy_bps,
        funding_end_ts,
        maturity_ts,
    });

    Ok(())
}

// ============================================
// Deposit Instruction
// ============================================

/// Accounts for user deposit during funding phase.
#[derive(Accounts)]
pub struct Deposit<'info> {
    /// Vault in Funding status.
    #[account(
        mut,
        seeds = [b"vault", vault.authority.as_ref(), vault.vault_id.to_le_bytes().as_ref()],
        bump = vault.bump,
        constraint = vault.status == VaultStatus::Funding @ VaultError::InvalidStatus
    )]
    pub vault: Account<'info, Vault>,

    #[account(
        mut,
        seeds = [b"vault_token", vault.key().as_ref()],
        bump,
        constraint = vault_token_account.owner == vault.key() @ VaultError::UnauthorizedAuthority
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    #[account(
        init_if_needed,
        payer = user,
        space = Position::LEN,
        seeds = [b"position", vault.key().as_ref(), user.key().as_ref()],
        bump
    )]
    pub position: Account<'info, Position>,

    #[account(
        mut,
        constraint = user_token_account.mint == vault.asset_mint @ VaultError::InvalidMint,
        constraint = user_token_account.owner == user.key()
    )]
    pub user_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

/// Deposits tokens into a vault during funding phase.
///
/// Validates: funding not ended, amount > 0, amount >= min_deposit, total <= cap.
/// Creates or updates user position PDA.
pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    let position = &mut ctx.accounts.position;
    let clock = Clock::get()?;

    // Validations
    require!(
        clock.unix_timestamp < vault.funding_end_ts,
        VaultError::FundingEnded
    );
    require!(amount > 0, VaultError::ZeroDeposit);
    require!(amount >= vault.min_deposit, VaultError::BelowMinDeposit);

    let new_total = vault
        .total_deposited
        .checked_add(amount)
        .ok_or(VaultError::ArithmeticOverflow)?;

    require!(new_total <= vault.cap, VaultError::CapExceeded);

    // Transfer tokens from user to vault
    let cpi_accounts = Transfer {
        from: ctx.accounts.user_token_account.to_account_info(),
        to: ctx.accounts.vault_token_account.to_account_info(),
        authority: ctx.accounts.user.to_account_info(),
    };
    let cpi_program = ctx.accounts.token_program.to_account_info();
    let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
    token::transfer(cpi_ctx, amount)?;

    // Initialize position if first deposit
    if position.deposited == 0 {
        position.vault = vault.key();
        position.owner = ctx.accounts.user.key();
        position.deposited = 0;
        position.claimed = 0;
        position.bump = ctx.bumps.position;
    }

    // Update position and vault
    position.deposited = position
        .deposited
        .checked_add(amount)
        .ok_or(VaultError::ArithmeticOverflow)?;

    vault.total_deposited = new_total;

    emit!(DepositEvent {
        vault: vault.key(),
        user: ctx.accounts.user.key(),
        amount,
        total_deposited: vault.total_deposited,
    });

    Ok(())
}

// ============================================
// Finalize Funding Instruction
// ============================================

/// Accounts required for finalizing the funding phase.
///
/// # Security Considerations
/// - Only authority can finalize
/// - Vault must be in Funding status
/// - All token accounts are validated for correct ownership and mint
#[derive(Accounts)]
pub struct FinalizeFunding<'info> {
    /// Vault in Funding status to be finalized.
    #[account(
        mut,
        seeds = [b"vault", vault.authority.as_ref(), vault.vault_id.to_le_bytes().as_ref()],
        bump = vault.bump,
        constraint = vault.status == VaultStatus::Funding @ VaultError::InvalidStatus,
        has_one = authority @ VaultError::UnauthorizedAuthority
    )]
    pub vault: Account<'info, Vault>,

    /// Vault's token account holding user deposits.
    #[account(
        mut,
        seeds = [b"vault_token", vault.key().as_ref()],
        bump,
        constraint = vault_token_account.owner == vault.key() @ VaultError::UnauthorizedAuthority
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    /// Authority's token account to receive funds if successful.
    #[account(
        mut,
        constraint = authority_token_account.mint == vault.asset_mint @ VaultError::InvalidMint,
        constraint = authority_token_account.owner == authority.key()
    )]
    pub authority_token_account: Account<'info, TokenAccount>,

    /// Vault authority.
    #[account(mut)]
    pub authority: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

/// Finalizes funding by checking 2/3 threshold: `total_deposited >= ceil(2/3 * cap)`.
///
/// Success (≥ 2/3): Transfers funds to authority, sets Active status.
/// Failure (< 2/3): Sets Canceled status, users can claim refunds.
pub fn finalize_funding(ctx: Context<FinalizeFunding>) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    let clock = Clock::get()?;

    // Check if funding period has ended OR cap is fully met
    require!(
        clock.unix_timestamp >= vault.funding_end_ts || vault.total_deposited == vault.cap,
        VaultError::FundingNotEnded
    );

    // Calculate 2/3 threshold using safe ceiling division
    // two_thirds = ceil(2/3 * cap) = (cap * 2 + 2) / 3
    let numerator = (vault.cap as u128)
        .checked_mul(2)
        .and_then(|n| n.checked_add(2))
        .ok_or(VaultError::ArithmeticOverflow)?;
    let two_thirds_u128 = numerator
        .checked_div(3)
        .ok_or(VaultError::ArithmeticOverflow)?;

    // Validate cast to u64 won't truncate (should never happen with MAX_VAULT_CAP)
    require!(
        two_thirds_u128 <= u64::MAX as u128,
        VaultError::ArithmeticOverflow
    );
    let two_thirds = two_thirds_u128 as u64;

    if vault.total_deposited < two_thirds {
        // Funding failed - mark as Canceled
        vault.status = VaultStatus::Canceled;

        emit!(FundingFinalized {
            vault: vault.key(),
            success: false,
            total_deposited: vault.total_deposited,
        });
    } else {
        // Funding successful
        let vault_key = vault.key();
        let amount = ctx.accounts.vault_token_account.amount;

        vault.status = VaultStatus::Active;

        // Perform the transfer
        let vault_id_bytes = vault.vault_id.to_le_bytes();
        let authority_key = vault.authority.key();
        let seeds = &[
            b"vault".as_ref(),
            authority_key.as_ref(),
            vault_id_bytes.as_ref(),
            &[vault.bump],
        ];
        let signer = &[&seeds[..]];

        let cpi_accounts = Transfer {
            from: ctx.accounts.vault_token_account.to_account_info(),
            to: ctx.accounts.authority_token_account.to_account_info(),
            authority: vault.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer);
        token::transfer(cpi_ctx, amount)?;

        emit!(AuthorityWithdraw {
            vault: vault_key,
            authority: vault.authority,
            amount,
        });

        emit!(FundingFinalized {
            vault: vault_key,
            success: true,
            total_deposited: vault.total_deposited,
        });
    }

    Ok(())
}

// ============================================
// Mature Vault Instruction
// ============================================

/// Accounts required for maturing a vault with returned funds.
///
/// # Security Considerations
/// - **CRITICAL**: Authority must transfer funds via CPI to prove return
/// - Vault must be in Active status
/// - Authority must own the authority_token_account
/// - Token account mint must match vault's asset_mint
/// - Vault token account ownership is validated
#[derive(Accounts)]
pub struct MatureVault<'info> {
    /// Vault account to be matured (must be Active status).
    #[account(
        mut,
        seeds = [b"vault", vault.authority.as_ref(), vault.vault_id.to_le_bytes().as_ref()],
        bump = vault.bump,
        constraint = vault.status == VaultStatus::Active @ VaultError::InvalidStatus,
        has_one = authority @ VaultError::UnauthorizedAuthority
    )]
    pub vault: Account<'info, Vault>,

    /// Vault's token account that will receive the returned funds.
    ///
    /// **Security**: Owner constraint prevents spoofed accounts.
    #[account(
        mut,
        seeds = [b"vault_token", vault.key().as_ref()],
        bump,
        constraint = vault_token_account.owner == vault.key() @ VaultError::UnauthorizedAuthority
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    /// Authority's token account - funds are transferred FROM here.
    ///
    /// **Security**: This is where the returned funds + yield must come from.
    /// The CPI transfer proves the authority is actually returning capital.
    #[account(
        mut,
        constraint = authority_token_account.mint == vault.asset_mint @ VaultError::InvalidMint,
        constraint = authority_token_account.owner == authority.key() @ VaultError::UnauthorizedAuthority
    )]
    pub authority_token_account: Account<'info, TokenAccount>,

    /// Vault authority who must return the funds.
    pub authority: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

/// Matures vault by accepting returned funds via CPI transfer.
///
/// **Security**: CPI transfer FROM authority TO vault proves funds were actually returned,
/// preventing theft. Sets payout ratio: `payout = deposited * return_amount / total_deposited`.
///
/// Example: 700 deposited, 770 returned → user with 400 gets floor(400 * 770/700) = 440.
pub fn mature_vault(ctx: Context<MatureVault>, return_amount: u64) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    let clock = Clock::get()?;

    // Check maturity timestamp
    require!(
        clock.unix_timestamp >= vault.maturity_ts,
        VaultError::NotMatured
    );

    require!(vault.total_deposited > 0, VaultError::ZeroTotalDeposited);

    require!(return_amount > 0, VaultError::ZeroDeposit);

    // Record balance before transfer for validation
    let balance_before = ctx.accounts.vault_token_account.amount;

    // Transfer funds from authority back to vault
    let cpi_ctx = CpiContext::new(
        ctx.accounts.token_program.to_account_info(),
        token::Transfer {
            from: ctx.accounts.authority_token_account.to_account_info(),
            to: ctx.accounts.vault_token_account.to_account_info(),
            authority: ctx.accounts.authority.to_account_info(),
        },
    );
    token::transfer(cpi_ctx, return_amount)?;

    // Reload account to verify actual transfer amount
    ctx.accounts.vault_token_account.reload()?;
    let balance_after = ctx.accounts.vault_token_account.amount;
    let actual_transferred = balance_after
        .checked_sub(balance_before)
        .ok_or(VaultError::ArithmeticOverflow)?;

    // Verify claimed amount matches actual transfer
    require!(
        actual_transferred == return_amount,
        VaultError::InsufficientFunds
    );

    // Calculate payout factor from returned amount
    vault.payout_num = return_amount as u128;
    vault.payout_den = vault.total_deposited as u128;
    vault.status = VaultStatus::Matured;

    emit!(Matured {
        vault: vault.key(),
        returned: return_amount,
        payout_num: vault.payout_num,
        payout_den: vault.payout_den,
    });

    Ok(())
}

// ============================================
// Claim Instruction
// ============================================

/// Accounts for claiming refunds (Canceled) or payouts (Matured).
#[derive(Accounts)]
pub struct Claim<'info> {
    /// Vault must be Canceled or Matured.
    #[account(
        mut,
        seeds = [b"vault", vault.authority.as_ref(), vault.vault_id.to_le_bytes().as_ref()],
        bump = vault.bump,
        constraint = vault.status == VaultStatus::Canceled || vault.status == VaultStatus::Matured @ VaultError::InvalidStatus
    )]
    pub vault: Account<'info, Vault>,

    #[account(
        mut,
        seeds = [b"vault_token", vault.key().as_ref()],
        bump,
        constraint = vault_token_account.owner == vault.key() @ VaultError::UnauthorizedAuthority
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [b"position", vault.key().as_ref(), user.key().as_ref()],
        bump = position.bump,
        has_one = vault,
        constraint = position.owner == user.key()
    )]
    pub position: Account<'info, Position>,

    #[account(
        mut,
        constraint = user_token_account.mint == vault.asset_mint @ VaultError::InvalidMint,
        constraint = user_token_account.owner == user.key()
    )]
    pub user_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

/// Claims refund (if Canceled) or payout (if Matured).
///
/// Canceled: Returns full deposited amount.
/// Matured: Returns floor(deposited * payout_num / payout_den).
pub fn claim(ctx: Context<Claim>) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    let position = &mut ctx.accounts.position;

    let entitled = if vault.status == VaultStatus::Canceled {
        // Refund full deposit
        position.deposited
    } else {
        // Calculate payout based on payout factor
        // entitled = floor(deposited * payout_num / payout_den)
        require!(vault.payout_den > 0, VaultError::ZeroTotalDeposited);

        let payout_u128 = ((position.deposited as u128)
            .checked_mul(vault.payout_num)
            .ok_or(VaultError::ArithmeticOverflow)?)
            .checked_div(vault.payout_den)
            .ok_or(VaultError::ArithmeticOverflow)?;

        // Validate result fits in u64 to prevent silent truncation
        require!(
            payout_u128 <= u64::MAX as u128,
            VaultError::ArithmeticOverflow
        );

        payout_u128 as u64
    };

    let to_pay = entitled
        .checked_sub(position.claimed)
        .ok_or(VaultError::NothingToClaim)?;

    require!(to_pay > 0, VaultError::NothingToClaim);

    // Prevents reentrancy
    position.claimed = position
        .claimed
        .checked_add(to_pay)
        .ok_or(VaultError::ArithmeticOverflow)?;

    vault.total_claimed = vault
        .total_claimed
        .checked_add(to_pay)
        .ok_or(VaultError::ArithmeticOverflow)?;

    // Perform transfer after state update
    let vault_key = vault.key();
    let vault_id_bytes = vault.vault_id.to_le_bytes();
    let authority_key = vault.authority.key();
    let seeds = &[
        b"vault".as_ref(),
        authority_key.as_ref(),
        vault_id_bytes.as_ref(),
        &[vault.bump],
    ];
    let signer = &[&seeds[..]];

    let cpi_accounts = Transfer {
        from: ctx.accounts.vault_token_account.to_account_info(),
        to: ctx.accounts.user_token_account.to_account_info(),
        authority: vault.to_account_info(),
    };
    let cpi_program = ctx.accounts.token_program.to_account_info();
    let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer);
    token::transfer(cpi_ctx, to_pay)?;

    emit!(ClaimEvent {
        vault: vault_key,
        user: ctx.accounts.user.key(),
        amount: to_pay,
    });

    Ok(())
}

// ============================================
// Close Vault Instruction
// ============================================

/// Accounts for closing an empty vault to reclaim rent.
#[derive(Accounts)]
pub struct CloseVault<'info> {
    /// Vault to close (must be Canceled or Matured with no remaining funds).
    #[account(
        mut,
        seeds = [b"vault", vault.authority.as_ref(), vault.vault_id.to_le_bytes().as_ref()],
        bump = vault.bump,
        constraint = vault.status == VaultStatus::Canceled || vault.status == VaultStatus::Matured @ VaultError::InvalidStatus,
        has_one = authority @ VaultError::UnauthorizedAuthority,
        close = authority
    )]
    pub vault: Account<'info, Vault>,

    /// Vault's token account - must be closed to reclaim rent and prevent orphaned accounts.
    #[account(
        mut,
        seeds = [b"vault_token", vault.key().as_ref()],
        bump,
        constraint = vault_token_account.owner == vault.key() @ VaultError::UnauthorizedAuthority
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

/// Closes an empty vault and reclaims rent to authority.
///
/// Validates: vault token account balance <= MAX_DUST_AMOUNT, vault in Canceled or Matured status.
/// Allows for minor dust from rounding errors in payout calculations.
/// Rent from vault account is transferred to authority automatically via Anchor's `close` constraint.
/// Token account is closed via SPL Token CloseAccount instruction to reclaim rent.
pub fn close_vault(ctx: Context<CloseVault>) -> Result<()> {
    let vault = &ctx.accounts.vault;

    // Ensure vault token account is empty or only has negligible dust
    require!(
        ctx.accounts.vault_token_account.amount <= MAX_DUST_AMOUNT,
        VaultError::CannotCloseWithFunds
    );

    // Close the token account to reclaim rent
    let vault_id_bytes = vault.vault_id.to_le_bytes();
    let authority_key = vault.authority.key();
    let seeds = &[
        b"vault".as_ref(),
        authority_key.as_ref(),
        vault_id_bytes.as_ref(),
        &[vault.bump],
    ];
    let signer = &[&seeds[..]];

    let cpi_accounts = token::CloseAccount {
        account: ctx.accounts.vault_token_account.to_account_info(),
        destination: ctx.accounts.authority.to_account_info(),
        authority: vault.to_account_info(),
    };
    let cpi_program = ctx.accounts.token_program.to_account_info();
    let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer);
    token::close_account(cpi_ctx)?;

    emit!(VaultClosed {
        vault: vault.key(),
        authority: vault.authority,
    });

    Ok(())
}
