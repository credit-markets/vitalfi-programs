use anchor_lang::prelude::*;

#[error_code]
pub enum VaultError {
    #[msg("Invalid mint provided")]
    InvalidMint,

    #[msg("Vault program is paused")]
    VaultPaused,

    #[msg("Invalid vault status for this operation")]
    InvalidStatus,

    #[msg("Funding period has not ended yet")]
    FundingNotEnded,

    #[msg("Funding period has ended")]
    FundingEnded,

    #[msg("Insufficient funds")]
    InsufficientFunds,

    #[msg("Deposit would exceed vault capacity")]
    CapExceeded,

    #[msg("Deposit amount below minimum")]
    BelowMinDeposit,

    #[msg("Vault has not matured yet")]
    NotMatured,

    #[msg("Vault is already matured")]
    AlreadyMatured,

    #[msg("Only vault authority can perform this action")]
    UnauthorizedAuthority,

    #[msg("Cannot close vault with remaining funds")]
    CannotCloseWithFunds,

    #[msg("Invalid timestamp configuration")]
    InvalidTimestamps,

    #[msg("Deposit amount must be greater than zero")]
    ZeroDeposit,

    #[msg("Arithmetic overflow")]
    ArithmeticOverflow,

    #[msg("No funds to claim")]
    NothingToClaim,

    #[msg("Funding threshold not met (< 2/3 cap)")]
    FundingThresholdNotMet,

    #[msg("Total deposited cannot be zero")]
    ZeroTotalDeposited,
}
