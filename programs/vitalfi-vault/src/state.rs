use anchor_lang::prelude::*;

#[account]
pub struct Campaign {
    /// Campaign creator
    pub creator: Pubkey,

    /// Funding goal in lamports
    pub goal: u64,

    /// Campaign deadline (Unix timestamp)
    pub deadline: i64,

    /// Total amount raised in lamports
    pub total_raised: u64,

    /// Total shares minted
    pub total_shares: u64,

    /// Campaign status
    pub status: CampaignStatus,

    /// PDA bump seed
    pub bump: u8,
}

impl Campaign {
    /// Space required for Campaign account
    /// 8 (discriminator) + 32 (creator) + 8 (goal) + 8 (deadline) + 8 (total_raised) + 8 (total_shares) + 1 (status) + 1 (bump)
    pub const LEN: usize = 8 + 32 + 8 + 8 + 8 + 8 + 1 + 1;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum CampaignStatus {
    Active,
    Successful,
    Failed,
}

#[account]
pub struct UserPosition {
    /// Campaign this position belongs to
    pub campaign: Pubkey,

    /// User's wallet address
    pub user: Pubkey,

    /// Non-transferable shares (1 SOL = 1 share)
    pub shares: u64,

    /// Total amount contributed in lamports
    pub contributed_amount: u64,

    /// PDA bump seed
    pub bump: u8,
}

impl UserPosition {
    /// Space required for UserPosition account
    /// 8 (discriminator) + 32 (campaign) + 32 (user) + 8 (shares) + 8 (contributed_amount) + 1 (bump)
    pub const LEN: usize = 8 + 32 + 32 + 8 + 8 + 1;
}
