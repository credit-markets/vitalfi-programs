use anchor_lang::prelude::*;

/// Global configuration for the vault program
/// PDA seeds: ["config"]
#[account]
pub struct GlobalConfig {
    /// Admin authority
    pub admin: Pubkey,

    /// Fee destination (unused for now, future use)
    pub fee_dest: Pubkey,

    /// Optional allowed mint (if None, any mint allowed)
    pub allowed_mint: Option<Pubkey>,

    /// Global pause flag
    pub paused: bool,

    /// PDA bump seed
    pub bump: u8,
}

impl GlobalConfig {
    /// 8 (discriminator) + 32 (admin) + 32 (fee_dest) + 1 + 32 (Option<Pubkey>) + 1 (paused) + 1 (bump)
    pub const LEN: usize = 8 + 32 + 32 + 1 + 32 + 1 + 1;
}

/// Main vault account
/// PDA seeds: ["vault", authority, vault_id (u64 LE bytes)]
#[account]
pub struct Vault {
    /// Version for future upgrades
    pub version: u16,

    /// Feature flags for future use
    pub feature_bits: u64,

    /// Vault authority (originator/operator)
    pub authority: Pubkey,

    /// Unique vault ID
    pub vault_id: u64,

    /// SPL token mint (e.g., wSOL, USDC)
    pub asset_mint: Pubkey,

    /// Vault's token account PDA
    pub vault_token: Pubkey,

    /// Maximum capacity in token units
    pub cap: u64,

    /// Target APY in basis points (display only)
    pub target_apy_bps: u32,

    /// Funding phase ends at this timestamp
    pub funding_end_ts: i64,

    /// Vault matures at this timestamp
    pub maturity_ts: i64,

    /// Minimum deposit amount
    pub min_deposit: u64,

    /// Current vault status
    pub status: VaultStatus,

    /// Total amount deposited by users
    pub total_deposited: u64,

    /// Total amount claimed by users
    pub total_claimed: u64,

    /// Payout numerator (amount returned at maturity)
    pub payout_num: u128,

    /// Payout denominator (total_deposited)
    pub payout_den: u128,

    /// PDA bump seed
    pub bump: u8,
}

impl Vault {
    /// 8 (discriminator) + 2 (version) + 8 (feature_bits) + 32 (authority) + 8 (vault_id)
    /// + 32 (asset_mint) + 32 (vault_token) + 8 (cap) + 4 (target_apy_bps)
    /// + 8 (funding_end_ts) + 8 (maturity_ts) + 8 (min_deposit) + 1 (status)
    /// + 8 (total_deposited) + 8 (total_claimed) + 16 (payout_num) + 16 (payout_den) + 1 (bump)
    pub const LEN: usize = 8 + 2 + 8 + 32 + 8 + 32 + 32 + 8 + 4 + 8 + 8 + 8 + 1 + 8 + 8 + 16 + 16 + 1;
}

/// Vault status enum
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum VaultStatus {
    /// Accepting deposits
    Funding = 0,
    /// Funded and active, funds withdrawn by authority
    Active = 1,
    /// Funding failed (< 2/3 cap), users can claim refunds
    Canceled = 2,
    /// Matured, users can claim payouts
    Matured = 3,
    /// Closed and cleaned up
    Closed = 4,
}

/// User position in a vault
/// PDA seeds: ["position", vault, user]
#[account]
pub struct Position {
    /// Vault this position belongs to
    pub vault: Pubkey,

    /// Owner's wallet address
    pub owner: Pubkey,

    /// Amount deposited during funding
    pub deposited: u64,

    /// Amount claimed (refund or payout)
    pub claimed: u64,

    /// PDA bump seed
    pub bump: u8,
}

impl Position {
    /// 8 (discriminator) + 32 (vault) + 32 (owner) + 8 (deposited) + 8 (claimed) + 1 (bump)
    pub const LEN: usize = 8 + 32 + 32 + 8 + 8 + 1;
}
