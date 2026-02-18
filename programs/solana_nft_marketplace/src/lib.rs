use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("4mgMZmcKv2dmFzVhAy9tBLQU3AJACYixWrSwGP1mFY5m");

#[program]
pub mod solana_nft_marketplace {
    use super::*;

    pub fn list(ctx: Context<List>, price: u64) -> Result<()> {
        instructions::trade::list(ctx, price)
    }

    pub fn cancel(ctx: Context<Cancel>) -> Result<()> {
        instructions::trade::cancel(ctx)
    }

    pub fn buy(ctx: Context<Buy>) -> Result<()> {
        instructions::trade::buy(ctx)
    }
}
