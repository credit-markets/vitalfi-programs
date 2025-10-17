use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Mint, Transfer};

use crate::errors::*;
use crate::events::*;
use crate::state::*;

// ============================================
// Initialize Vault Instruction
// ============================================

#[derive(Accounts)]
#[instruction(vault_id: u64)]
pub struct InitializeVault<'info> {
    #[account(
        init,
        payer = authority,
        space = Vault::LEN,
        seeds = [b"vault", authority.key().as_ref(), vault_id.to_le_bytes().as_ref()],
        bump
    )]
    pub vault: Account<'info, Vault>,

    #[account(
        init,
        payer = authority,
        seeds = [b"vault_token", vault.key().as_ref()],
        bump,
        token::mint = asset_mint,
        token::authority = vault,
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    pub asset_mint: Account<'info, Mint>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

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

    // Validate timestamps
    require!(
        funding_end_ts > clock.unix_timestamp,
        VaultError::InvalidTimestamps
    );
    require!(
        maturity_ts > funding_end_ts,
        VaultError::InvalidTimestamps
    );

    // Initialize vault
    vault.version = 1;
    vault.feature_bits = 0;
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

#[derive(Accounts)]
pub struct Deposit<'info> {
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

#[derive(Accounts)]
pub struct FinalizeFunding<'info> {
    #[account(
        mut,
        seeds = [b"vault", vault.authority.as_ref(), vault.vault_id.to_le_bytes().as_ref()],
        bump = vault.bump,
        constraint = vault.status == VaultStatus::Funding @ VaultError::InvalidStatus,
        has_one = authority @ VaultError::UnauthorizedAuthority
    )]
    pub vault: Account<'info, Vault>,

    #[account(
        mut,
        seeds = [b"vault_token", vault.key().as_ref()],
        bump,
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = authority_token_account.mint == vault.asset_mint @ VaultError::InvalidMint,
        constraint = authority_token_account.owner == authority.key()
    )]
    pub authority_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

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
    let two_thirds = ((vault.cap as u128)
        .checked_mul(2)
        .ok_or(VaultError::ArithmeticOverflow)?
        .checked_add(2)
        .ok_or(VaultError::ArithmeticOverflow)?)
        .checked_div(3)
        .ok_or(VaultError::ArithmeticOverflow)? as u64;

    if vault.total_deposited < two_thirds {
        // Funding failed - mark as Canceled
        vault.status = VaultStatus::Canceled;

        emit!(FundingFinalized {
            vault: vault.key(),
            success: false,
            total_deposited: vault.total_deposited,
        });
    } else {
        // Funding successful - withdraw all funds to authority
        let amount = ctx.accounts.vault_token_account.amount;

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
            to: ctx.accounts.authority_token_account.to_account_info(),
            authority: vault.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer);
        token::transfer(cpi_ctx, amount)?;

        vault.status = VaultStatus::Active;

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

#[derive(Accounts)]
pub struct MatureVault<'info> {
    #[account(
        mut,
        seeds = [b"vault", vault.authority.as_ref(), vault.vault_id.to_le_bytes().as_ref()],
        bump = vault.bump,
        constraint = vault.status == VaultStatus::Active @ VaultError::InvalidStatus,
        has_one = authority @ VaultError::UnauthorizedAuthority
    )]
    pub vault: Account<'info, Vault>,

    #[account(
        mut,
        seeds = [b"vault_token", vault.key().as_ref()],
        bump,
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    pub authority: Signer<'info>,
}

pub fn mature_vault(ctx: Context<MatureVault>) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    let clock = Clock::get()?;

    // Check maturity timestamp
    require!(
        clock.unix_timestamp >= vault.maturity_ts,
        VaultError::NotMatured
    );

    require!(
        vault.total_deposited > 0,
        VaultError::ZeroTotalDeposited
    );

    // Calculate payout factor from returned amount
    let returned = ctx.accounts.vault_token_account.amount;

    vault.payout_num = returned as u128;
    vault.payout_den = vault.total_deposited as u128;
    vault.status = VaultStatus::Matured;

    emit!(Matured {
        vault: vault.key(),
        returned,
        payout_num: vault.payout_num,
        payout_den: vault.payout_den,
    });

    Ok(())
}

// ============================================
// Claim Instruction
// ============================================

#[derive(Accounts)]
pub struct Claim<'info> {
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

        ((position.deposited as u128)
            .checked_mul(vault.payout_num)
            .ok_or(VaultError::ArithmeticOverflow)?)
            .checked_div(vault.payout_den)
            .ok_or(VaultError::ArithmeticOverflow)? as u64
    };

    let to_pay = entitled
        .checked_sub(position.claimed)
        .ok_or(VaultError::NothingToClaim)?;

    require!(to_pay > 0, VaultError::NothingToClaim);

    // Transfer from vault to user
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

    // Update state
    position.claimed = position
        .claimed
        .checked_add(to_pay)
        .ok_or(VaultError::ArithmeticOverflow)?;

    vault.total_claimed = vault
        .total_claimed
        .checked_add(to_pay)
        .ok_or(VaultError::ArithmeticOverflow)?;

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

#[derive(Accounts)]
pub struct CloseVault<'info> {
    #[account(
        mut,
        seeds = [b"vault", vault.authority.as_ref(), vault.vault_id.to_le_bytes().as_ref()],
        bump = vault.bump,
        constraint = vault.status == VaultStatus::Canceled || vault.status == VaultStatus::Matured @ VaultError::InvalidStatus,
        has_one = authority @ VaultError::UnauthorizedAuthority,
        close = authority
    )]
    pub vault: Account<'info, Vault>,

    #[account(
        mut,
        seeds = [b"vault_token", vault.key().as_ref()],
        bump,
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub authority: Signer<'info>,
}

pub fn close_vault(ctx: Context<CloseVault>) -> Result<()> {
    let vault = &ctx.accounts.vault;

    // Ensure vault token account is empty (or only dust remains)
    require!(
        ctx.accounts.vault_token_account.amount == 0,
        VaultError::CannotCloseWithFunds
    );

    emit!(VaultClosed {
        vault: vault.key(),
        authority: vault.authority,
    });

    Ok(())
}
