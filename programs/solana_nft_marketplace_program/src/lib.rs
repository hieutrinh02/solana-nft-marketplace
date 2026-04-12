use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("FnZUe7Vwefyr7wiyP4qR6rHYiANAcsHYLH4aVYXwVdzh");

#[program]
pub mod solana_nft_marketplace_program {
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

    pub fn make_offer(ctx: Context<MakeOffer>, price: u64) -> Result<()> {
        instructions::offer::make_offer(ctx, price)
    }

    pub fn cancel_offer(ctx: Context<CancelOffer>) -> Result<()> {
        instructions::offer::cancel_offer(ctx)
    }

    pub fn accept_offer(ctx: Context<AcceptOffer>) -> Result<()> {
        instructions::offer::accept_offer(ctx)
    }
}
