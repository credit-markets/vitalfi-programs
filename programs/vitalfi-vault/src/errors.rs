use anchor_lang::prelude::*;

#[error_code]
pub enum CrowdfundError {
    #[msg("Campaign deadline has passed")]
    DeadlinePassed,

    #[msg("Campaign deadline has not been reached yet")]
    DeadlineNotReached,

    #[msg("Campaign is not active")]
    CampaignNotActive,

    #[msg("Goal has not been met")]
    GoalNotMet,

    #[msg("Goal has been met, refunds not available")]
    GoalMet,

    #[msg("Only campaign creator can perform this action")]
    UnauthorizedCreator,

    #[msg("Invalid deadline, must be in the future")]
    InvalidDeadline,

    #[msg("Contribution amount must be greater than zero")]
    ZeroContribution,
}
