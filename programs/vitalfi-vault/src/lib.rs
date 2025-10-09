use anchor_lang::prelude::*;

declare_id!("146hbPFqGb9a3v3t1BtkmftNeSNqXzoydzVPk95YtJNj");

#[program]
pub mod vitalfi_vault {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        msg!("Greetings from: {:?}", ctx.program_id);
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize {}
