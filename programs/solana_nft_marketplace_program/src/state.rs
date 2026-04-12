use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct Listing {
    pub seller: Pubkey,
    pub mint: Pubkey,
    pub price: u64,
    pub bump: u8,
}

impl Listing {
    pub const SEED_PREFIX: &'static [u8; 7] = b"listing";
}

#[account]
#[derive(InitSpace)]
pub struct Offer {
    pub buyer: Pubkey,
    pub mint: Pubkey,
    pub price: u64,
    pub bump: u8,
}

impl Offer {
    pub const SEED_PREFIX: &'static [u8; 5] = b"offer";
}
