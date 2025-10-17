// Suppress deprecation warning from Anchor's macro expansion (Anchor 0.31.1 issue)
#![allow(deprecated)]

use anchor_lang::prelude::*;

mod errors;
mod events;
mod instructions;
mod state;

pub use errors::*;
pub use events::*;
pub use state::*;

// Re-export instructions module items
#[allow(ambiguous_glob_reexports)]
pub use instructions::*;

declare_id!("146hbPFqGb9a3v3t1BtkmftNeSNqXzoydzVPk95YtJNj");

#[program]
pub mod vitalfi_vault {
    use super::*;

    /// Initialize a new vault with funding parameters
    pub fn initialize_vault(
        ctx: Context<InitializeVault>,
        vault_id: u64,
        cap: u64,
        target_apy_bps: u32,
        funding_end_ts: i64,
        maturity_ts: i64,
        min_deposit: u64,
    ) -> Result<()> {
        instructions::initialize_vault(
            ctx,
            vault_id,
            cap,
            target_apy_bps,
            funding_end_ts,
            maturity_ts,
            min_deposit,
        )
    }

    /// Deposit tokens into a vault during funding phase
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        instructions::deposit(ctx, amount)
    }

    /// Finalize funding - checks 2/3 threshold and either cancels or activates vault
    pub fn finalize_funding(ctx: Context<FinalizeFunding>) -> Result<()> {
        instructions::finalize_funding(ctx)
    }

    /// Mature the vault and calculate payout factor based on returned funds
    pub fn mature_vault(ctx: Context<MatureVault>) -> Result<()> {
        instructions::mature_vault(ctx)
    }

    /// Claim refund (if canceled) or payout (if matured)
    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        instructions::claim(ctx)
    }

    /// Close vault and reclaim rent (only when empty)
    pub fn close_vault(ctx: Context<CloseVault>) -> Result<()> {
        instructions::close_vault(ctx)
    }
}
