
use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer};
declare_id!("FWJTeHoNHWBCmKepVsNDS5MnLh891BfsK2HyLAJBj9sY");
#[program]
pub mod guardian {
use super::*;
pub fn initialize(
ctx: Context<Initialize>,
agent: Pubkey,
daily_limit: u64,
allowed: Vec<Pubkey>,
) -> Result<()> {
require!(allowed.len() <= 8, GuardianError::TooManyAllowed);
let policy = &mut ctx.accounts.policy;
policy.owner = ctx.accounts.owner.key();
policy.agent = agent;
policy.daily_limit = daily_limit;
policy.spent = 0;
policy.window_start = Clock::get()?.unix_timestamp;
policy.paused = false;
policy.policy_bump = ctx.bumps.policy;
policy.vault_bump = ctx.bumps.vault;
policy.allowed = allowed;
Ok(())
}
pub fn deposit(ctx: Context<OwnerVault>, amount: u64) -> Result<()> {
system_program::transfer(
CpiContext::new(
ctx.accounts.system_program.to_account_info(),
Transfer {
from: ctx.accounts.owner.to_account_info(),
to: ctx.accounts.vault.to_account_info(),
},
),
amount,
)
}
pub fn withdraw(ctx: Context<OwnerVault>, amount: u64) -> Result<()> {
let policy_key = ctx.accounts.policy.key();
let bump = [ctx.accounts.policy.vault_bump];
let seeds: &[&[u8]] = &[b"vault", policy_key.as_ref(), &bump];
system_program::transfer(
CpiContext::new_with_signer(
ctx.accounts.system_program.to_account_info(),
Transfer {
from: ctx.accounts.vault.to_account_info(),
to: ctx.accounts.owner.to_account_info(),
},
&[seeds],
),
amount,
)
}
pub fn update_policy(
ctx: Context<UpdatePolicy>,
agent: Pubkey,
daily_limit: u64,
allowed: Vec<Pubkey>,
paused: bool,
) -> Result<()> {
require!(allowed.len() <= 8, GuardianError::TooManyAllowed);
let policy = &mut ctx.accounts.policy;
policy.agent = agent;
policy.daily_limit = daily_limit;
policy.allowed = allowed;
policy.paused = paused;
Ok(())
}
pub fn agent_transfer(ctx: Context<AgentTransfer>, amount: u64) -> Result<()> {
let policy_key = ctx.accounts.policy.key();
let recipient_key = ctx.accounts.recipient.key();
let now = Clock::get()?.unix_timestamp;
let policy = &mut ctx.accounts.policy;
require!(!policy.paused, GuardianError::Paused);
require!(
policy.allowed.contains(&recipient_key),
GuardianError::RecipientNotAllowed
);
if now - policy.window_start >= 86_400 {
policy.window_start = now;
policy.spent = 0;
}
let new_spent = policy
.spent
.checked_add(amount)
.ok_or(GuardianError::MathOverflow)?;
require!(new_spent <= policy.daily_limit, GuardianError::DailyLimitExceeded);
policy.spent = new_spent;
let bump = [policy.vault_bump];
let seeds: &[&[u8]] = &[b"vault", policy_key.as_ref(), &bump];
system_program::transfer(
CpiContext::new_with_signer(
ctx.accounts.system_program.to_account_info(),
Transfer {
from: ctx.accounts.vault.to_account_info(),
to: ctx.accounts.recipient.to_account_info(),
},
&[seeds],
),
amount,
)
}
}
#[derive(Accounts)]
pub struct Initialize<'info> {
#[account(mut)]
pub owner: Signer<'info>,
#[account(
init,
payer = owner,
space = 8 + Policy::INIT_SPACE,
seeds = [b"policy", owner.key().as_ref()],
bump
)]
pub policy: Account<'info, Policy>,
#[account(seeds = [b"vault", policy.key().as_ref()], bump)]
pub vault: SystemAccount<'info>,
pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct OwnerVault<'info> {
#[account(mut)]
pub owner: Signer<'info>,
#[account(
seeds = [b"policy", owner.key().as_ref()],
bump = policy.policy_bump,
has_one = owner
)]
pub policy: Account<'info, Policy>,
#[account(mut, seeds = [b"vault", policy.key().as_ref()], bump = policy.vault_bump)]
pub vault: SystemAccount<'info>,
pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct UpdatePolicy<'info> {
pub owner: Signer<'info>,
#[account(
mut,
seeds = [b"policy", owner.key().as_ref()],
bump = policy.policy_bump,
has_one = owner
)]
pub policy: Account<'info, Policy>,
}
#[derive(Accounts)]
pub struct AgentTransfer<'info> {
pub agent: Signer<'info>,
#[account(
mut,
seeds = [b"policy", policy.owner.as_ref()],
bump = policy.policy_bump,
constraint = agent.key() == policy.agent @ GuardianError::NotAgent
)]
pub policy: Account<'info, Policy>,
#[account(mut, seeds = [b"vault", policy.key().as_ref()], bump = policy.vault_bump)]
pub vault: SystemAccount<'info>,
#[account(mut)]
pub recipient: SystemAccount<'info>,
pub system_program: Program<'info, System>,
}
#[account]
#[derive(InitSpace)]
pub struct Policy {
pub owner: Pubkey,
pub agent: Pubkey,
pub daily_limit: u64,
pub spent: u64,
pub window_start: i64,
pub paused: bool,
pub policy_bump: u8,
pub vault_bump: u8,
#[max_len(8)]
pub allowed: Vec<Pubkey>,
}
#[error_code]
pub enum GuardianError {
#[msg("Agent is paused")]
Paused,
#[msg("Recipient is not on the allowlist")]
RecipientNotAllowed,
#[msg("Daily limit exceeded")]
DailyLimitExceeded,
#[msg("Signer is not the agent")]
NotAgent,
#[msg("Too many allowed addresses (max 8)")]
TooManyAllowed,
#[msg("Math overflow")]
MathOverflow,
  }
