use anchor_lang::prelude::*;

#[error_code]
pub enum Error {
    #[msg("Insufficient funds")]
    InsufficientFunds,

    #[msg("Escrow ATA must have 1 NFT token")]
    InvalidEscrowAmount,

    #[msg("Mint authority must be none")]
    InvalidMintAuthority,

    #[msg("Mint decimals must be 0")]
    InvalidMintDecimals,

    #[msg("Freeze authority must be none")]
    InvalidFreezeAuthority,

    #[msg("Mint supply must be 1")]
    InvalidMintSupply,

    #[msg("Seller ATA must contain exactly 1 NFT token")]
    InvalidNftAmount,

    #[msg("Invalid price")]
    InvalidPrice,

    #[msg("Self buy is not allowed")]
    SelfBuyNotAllowed,
}
