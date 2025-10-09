use anchor_lang::prelude::*;

mod errors;
mod events;
mod instructions;
mod state;

pub use errors::*;
pub use events::*;
pub use instructions::*;
pub use state::*;

declare_id!("146hbPFqGb9a3v3t1BtkmftNeSNqXzoydzVPk95YtJNj");

#[program]
pub mod vitalfi_vault {
    use super::*;

    pub fn initialize_campaign(ctx: Context<InitializeCampaign>, goal: u64, deadline: i64) -> Result<()> {
        instructions::initialize_campaign(ctx, goal, deadline)
    }

    pub fn contribute(ctx: Context<Contribute>, amount: u64) -> Result<()> {
        instructions::contribute(ctx, amount)
    }

    pub fn claim_funds(ctx: Context<ClaimFunds>) -> Result<()> {
        instructions::claim_funds(ctx)
    }

    pub fn refund(ctx: Context<Refund>) -> Result<()> {
        instructions::refund(ctx)
    }
}
