use anchor_lang::prelude::*;

#[error_code]
pub enum Error {
    #[msg("Insufficient funds")]
    InsufficientFunds,

    #[msg("Invalid listing price")]
    InvalidListingPrice,

    #[msg("Invalid offer price")]
    InvalidOfferPrice,

    #[msg("Mint decimals must be 0")]
    InvalidMintDecimals,

    #[msg("Mint supply must be 1")]
    InvalidMintSupply,

    #[msg("Seller ATA must contain exactly 1 NFT token")]
    InvalidNftAmount,

    #[msg("Escrow ATA must have 1 NFT token")]
    InvalidEscrowAmount,

    #[msg("Invalid metadata account")]
    InvalidMetadataAccount,

    #[msg("Metadata account must be owned by the Metaplex Token Metadata program")]
    InvalidMetadataOwner,

    #[msg("Metadata mint does not match the NFT mint")]
    MetadataMintMismatch,

    #[msg("Metadata collection is required")]
    MetadataCollectionRequired,

    #[msg("Metadata collection must be verified")]
    MetadataCollectionNotVerified,

    #[msg("Collection NFTs are not supported")]
    CollectionNftNotSupported,

    #[msg("Metadata uses are not supported")]
    MetadataUsesNotSupported,

    #[msg("Unsupported metadata token standard")]
    UnsupportedMetadataTokenStandard,

    #[msg("Buyer cannot buy their own listing")]
    BuyOwnListingNotAllowed,

    #[msg("Seller cannot accept their own offer")]
    AcceptOwnOfferNotAllowed,
}
