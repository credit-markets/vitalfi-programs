use anchor_lang::prelude::*;

#[event]
pub struct VaultCreated {
    pub vault: Pubkey,
    pub authority: Pubkey,
    pub vault_id: u64,
    pub asset_mint: Pubkey,
    pub cap: u64,
    pub target_apy_bps: u32,
    pub funding_end_ts: i64,
    pub maturity_ts: i64,
}

#[event]
pub struct DepositEvent {
    pub vault: Pubkey,
    pub user: Pubkey,
    pub amount: u64,
    pub total_deposited: u64,
}

#[event]
pub struct FundingFinalized {
    pub vault: Pubkey,
    pub success: bool,
    pub total_deposited: u64,
}

#[event]
pub struct AuthorityWithdraw {
    pub vault: Pubkey,
    pub authority: Pubkey,
    pub amount: u64,
}

#[event]
pub struct Matured {
    pub vault: Pubkey,
    pub returned: u64,
    pub payout_num: u128,
    pub payout_den: u128,
}

#[event]
pub struct ClaimEvent {
    pub vault: Pubkey,
    pub user: Pubkey,
    pub amount: u64,
}

#[event]
pub struct VaultClosed {
    pub vault: Pubkey,
    pub authority: Pubkey,
}
