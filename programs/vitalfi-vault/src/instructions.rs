use anchor_lang::prelude::*;
use anchor_lang::system_program;

use crate::errors::*;
use crate::events::*;
use crate::state::*;

// ============================================
// Initialize Campaign Instruction
// ============================================

#[derive(Accounts)]
pub struct InitializeCampaign<'info> {
    #[account(
        init,
        payer = creator,
        space = Campaign::LEN,
        seeds = [b"campaign", creator.key().as_ref()],
        bump
    )]
    pub campaign: Account<'info, Campaign>,

    #[account(mut)]
    pub creator: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn initialize_campaign(ctx: Context<InitializeCampaign>, goal: u64, deadline: i64) -> Result<()> {
    let campaign = &mut ctx.accounts.campaign;
    let clock = Clock::get()?;

    require!(deadline > clock.unix_timestamp, CrowdfundError::InvalidDeadline);

    campaign.creator = ctx.accounts.creator.key();
    campaign.goal = goal;
    campaign.deadline = deadline;
    campaign.total_raised = 0;
    campaign.total_shares = 0;
    campaign.status = CampaignStatus::Active;
    campaign.bump = ctx.bumps.campaign;

    emit!(CampaignCreated {
        campaign: campaign.key(),
        creator: campaign.creator,
        goal: campaign.goal,
        deadline: campaign.deadline,
    });

    Ok(())
}

// ============================================
// Contribute Instruction
// ============================================

#[derive(Accounts)]
pub struct Contribute<'info> {
    #[account(
        mut,
        seeds = [b"campaign", campaign.creator.as_ref()],
        bump = campaign.bump,
        constraint = campaign.status == CampaignStatus::Active @ CrowdfundError::CampaignNotActive
    )]
    pub campaign: Account<'info, Campaign>,

    #[account(
        init_if_needed,
        payer = user,
        space = UserPosition::LEN,
        seeds = [b"position", campaign.key().as_ref(), user.key().as_ref()],
        bump
    )]
    pub user_position: Account<'info, UserPosition>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn contribute(ctx: Context<Contribute>, amount: u64) -> Result<()> {
    let campaign = &mut ctx.accounts.campaign;
    let user_position = &mut ctx.accounts.user_position;
    let clock = Clock::get()?;

    require!(clock.unix_timestamp < campaign.deadline, CrowdfundError::DeadlinePassed);
    require!(amount > 0, CrowdfundError::ZeroContribution);

    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.user.to_account_info(),
                to: campaign.to_account_info(),
            },
        ),
        amount,
    )?;

    let shares = amount;

    if user_position.shares == 0 {
        user_position.campaign = campaign.key();
        user_position.user = ctx.accounts.user.key();
        user_position.bump = ctx.bumps.user_position;
    }

    user_position.shares = user_position.shares.checked_add(shares).unwrap();
    user_position.contributed_amount = user_position.contributed_amount.checked_add(amount).unwrap();

    campaign.total_raised = campaign.total_raised.checked_add(amount).unwrap();
    campaign.total_shares = campaign.total_shares.checked_add(shares).unwrap();

    emit!(ContributionMade {
        campaign: campaign.key(),
        user: ctx.accounts.user.key(),
        amount,
        shares,
    });

    Ok(())
}

// ============================================
// Claim Funds Instruction
// ============================================

#[derive(Accounts)]
pub struct ClaimFunds<'info> {
    #[account(
        mut,
        seeds = [b"campaign", creator.key().as_ref()],
        bump = campaign.bump,
        has_one = creator @ CrowdfundError::UnauthorizedCreator
    )]
    pub campaign: Account<'info, Campaign>,

    #[account(mut)]
    pub creator: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn claim_funds(ctx: Context<ClaimFunds>) -> Result<()> {
    let campaign = &mut ctx.accounts.campaign;
    let clock = Clock::get()?;

    require!(clock.unix_timestamp >= campaign.deadline, CrowdfundError::DeadlineNotReached);
    require!(campaign.total_raised >= campaign.goal, CrowdfundError::GoalNotMet);
    require!(campaign.status == CampaignStatus::Active, CrowdfundError::CampaignNotActive);

    let amount = campaign.total_raised;

    **campaign.to_account_info().try_borrow_mut_lamports()? = campaign
        .to_account_info()
        .lamports()
        .checked_sub(amount)
        .unwrap();

    **ctx.accounts.creator.to_account_info().try_borrow_mut_lamports()? = ctx
        .accounts
        .creator
        .to_account_info()
        .lamports()
        .checked_add(amount)
        .unwrap();

    campaign.status = CampaignStatus::Successful;

    emit!(FundsClaimed {
        campaign: campaign.key(),
        creator: campaign.creator,
        amount,
    });

    Ok(())
}

// ============================================
// Refund Instruction
// ============================================

#[derive(Accounts)]
pub struct Refund<'info> {
    #[account(
        mut,
        seeds = [b"campaign", campaign.creator.as_ref()],
        bump = campaign.bump
    )]
    pub campaign: Account<'info, Campaign>,

    #[account(
        mut,
        seeds = [b"position", campaign.key().as_ref(), user.key().as_ref()],
        bump = user_position.bump,
        has_one = user,
        close = user
    )]
    pub user_position: Account<'info, UserPosition>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn refund(ctx: Context<Refund>) -> Result<()> {
    let campaign = &mut ctx.accounts.campaign;
    let user_position = &ctx.accounts.user_position;
    let clock = Clock::get()?;

    require!(clock.unix_timestamp >= campaign.deadline, CrowdfundError::DeadlineNotReached);
    require!(campaign.total_raised < campaign.goal, CrowdfundError::GoalMet);

    let refund_amount = user_position.contributed_amount;

    **campaign.to_account_info().try_borrow_mut_lamports()? = campaign
        .to_account_info()
        .lamports()
        .checked_sub(refund_amount)
        .unwrap();

    **ctx.accounts.user.to_account_info().try_borrow_mut_lamports()? = ctx
        .accounts
        .user
        .to_account_info()
        .lamports()
        .checked_add(refund_amount)
        .unwrap();

    campaign.total_raised = campaign.total_raised.checked_sub(refund_amount).unwrap();
    campaign.total_shares = campaign.total_shares.checked_sub(user_position.shares).unwrap();

    if campaign.status == CampaignStatus::Active {
        campaign.status = CampaignStatus::Failed;
    }

    emit!(RefundIssued {
        campaign: campaign.key(),
        user: ctx.accounts.user.key(),
        amount: refund_amount,
    });

    Ok(())
}
