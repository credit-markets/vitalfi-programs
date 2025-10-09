use anchor_lang::prelude::*;

#[event]
pub struct CampaignCreated {
    pub campaign: Pubkey,
    pub creator: Pubkey,
    pub goal: u64,
    pub deadline: i64,
}

#[event]
pub struct ContributionMade {
    pub campaign: Pubkey,
    pub user: Pubkey,
    pub amount: u64,
    pub shares: u64,
}

#[event]
pub struct FundsClaimed {
    pub campaign: Pubkey,
    pub creator: Pubkey,
    pub amount: u64,
}

#[event]
pub struct RefundIssued {
    pub campaign: Pubkey,
    pub user: Pubkey,
    pub amount: u64,
}
