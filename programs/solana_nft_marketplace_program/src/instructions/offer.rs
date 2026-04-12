use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Mint, Token, TokenAccount, Transfer},
};
use mpl_token_metadata::{
    accounts::Metadata, types::TokenStandard, ID as TOKEN_METADATA_PROGRAM_ID,
};

use crate::{errors::Error, state::Offer};

// -------------------------------
// Accounts
// -------------------------------

#[derive(Accounts)]
pub struct MakeOffer<'info> {
    /// The buyer making an offer for the NFT.
    #[account(mut)]
    pub buyer: Signer<'info>,

    /// The mint of the NFT being offered on.
    pub mint: Account<'info, Mint>,

    /// Offer PDA: seeds = ["offer", buyer, mint]
    /// - Stores offer info (buyer, mint, price, bump)
    /// - Holds the escrowed SOL in its lamports balance
    #[account(
        init,
        payer = buyer,
        space = 8 + Offer::INIT_SPACE,
        seeds = [Offer::SEED_PREFIX, buyer.key().as_ref(), mint.key().as_ref()],
        bump
    )]
    pub offer: Account<'info, Offer>,

    /// CHECK: validated against the Metaplex metadata PDA and deserialized in `make_offer`.
    pub metadata: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CancelOffer<'info> {
    /// Buyer cancels their offer.
    #[account(mut)]
    pub buyer: Signer<'info>,

    /// The mint of the NFT being offered on.
    pub mint: Account<'info, Mint>,

    /// Offer PDA must match seeds and must belong to this buyer/mint pair.
    #[account(
        mut,
        seeds = [Offer::SEED_PREFIX, buyer.key().as_ref(), mint.key().as_ref()],
        bump = offer.bump,
        has_one = buyer,
        has_one = mint,
        close = buyer
    )]
    pub offer: Account<'info, Offer>,
}

#[derive(Accounts)]
pub struct AcceptOffer<'info> {
    /// Seller accepts an offer for their NFT.
    #[account(mut)]
    pub seller: Signer<'info>,

    /// Buyer receiving the NFT and rent refund from close.
    /// CHECK: verified via `offer.has_one = buyer` and used as ATA authority / close recipient only.
    #[account(mut)]
    pub buyer: UncheckedAccount<'info>,

    /// The mint of the NFT being offered on.
    pub mint: Account<'info, Mint>,

    /// Offer PDA must match seeds and must belong to this buyer/mint pair.
    #[account(
        mut,
        seeds = [Offer::SEED_PREFIX, buyer.key().as_ref(), mint.key().as_ref()],
        bump = offer.bump,
        has_one = buyer,
        has_one = mint,
        close = buyer
    )]
    pub offer: Account<'info, Offer>,

    /// Seller's ATA holding the NFT.
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = seller
    )]
    pub seller_nft_ata: Account<'info, TokenAccount>,

    /// Buyer's ATA receiving the NFT.
    #[account(
        init_if_needed,
        payer = seller,
        associated_token::mint = mint,
        associated_token::authority = buyer
    )]
    pub buyer_nft_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

// -------------------------------
// Instructions
// -------------------------------

pub fn make_offer(ctx: Context<MakeOffer>, price: u64) -> Result<()> {
    // --- Validations ---
    require!(price > 0, Error::InvalidOfferPrice);
    require!(ctx.accounts.mint.decimals == 0, Error::InvalidMintDecimals);
    require!(ctx.accounts.mint.supply == 1, Error::InvalidMintSupply);
    require!(
        *ctx.accounts.metadata.to_account_info().owner == TOKEN_METADATA_PROGRAM_ID,
        Error::InvalidMetadataOwner
    );

    let (expected_metadata, _) = Metadata::find_pda(&ctx.accounts.mint.key());
    require!(
        ctx.accounts.metadata.key() == expected_metadata,
        Error::InvalidMetadataAccount
    );

    let metadata_account = Metadata::safe_deserialize(&ctx.accounts.metadata.data.borrow())
        .map_err(|_| error!(Error::InvalidMetadataAccount))?;

    require!(
        metadata_account.mint == ctx.accounts.mint.key(),
        Error::MetadataMintMismatch
    );
    require!(
        metadata_account.collection_details.is_none(),
        Error::CollectionNftNotSupported
    );
    require!(
        metadata_account.uses.is_none(),
        Error::MetadataUsesNotSupported
    );

    let collection = metadata_account
        .collection
        .ok_or_else(|| error!(Error::MetadataCollectionRequired))?;
    require!(collection.verified, Error::MetadataCollectionNotVerified);

    require!(
        matches!(
            metadata_account.token_standard,
            Some(TokenStandard::NonFungible)
        ),
        Error::UnsupportedMetadataTokenStandard
    );

    require!(
        ctx.accounts.buyer.lamports() >= price,
        Error::InsufficientFunds
    );

    // --- Store offer state ---
    let offer = &mut ctx.accounts.offer;
    offer.buyer = ctx.accounts.buyer.key();
    offer.mint = ctx.accounts.mint.key();
    offer.price = price;
    offer.bump = ctx.bumps.offer;

    // --- Move SOL from buyer wallet into offer PDA escrow ---
    let transfer_ix = anchor_lang::solana_program::system_instruction::transfer(
        &ctx.accounts.buyer.key(),
        &ctx.accounts.offer.key(),
        price,
    );
    anchor_lang::solana_program::program::invoke(
        &transfer_ix,
        &[
            ctx.accounts.buyer.to_account_info(),
            ctx.accounts.offer.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
        ],
    )?;

    Ok(())
}

pub fn cancel_offer(ctx: Context<CancelOffer>) -> Result<()> {
    // --- Validations ---
    let price = ctx.accounts.offer.price;
    require!(price > 0, Error::InvalidOfferPrice);
    require!(
        ctx.accounts.offer.to_account_info().lamports() >= price,
        Error::InsufficientFunds
    );

    // --- Refund escrowed SOL from offer PDA back to buyer ---
    **ctx
        .accounts
        .offer
        .to_account_info()
        .try_borrow_mut_lamports()? -= price;
    **ctx.accounts.buyer.try_borrow_mut_lamports()? += price;

    // Offer account will be closed automatically via `close = buyer`
    Ok(())
}
pub fn accept_offer(ctx: Context<AcceptOffer>) -> Result<()> {
    // --- Validations ---
    require!(
        ctx.accounts.seller.key() != ctx.accounts.buyer.key(),
        Error::AcceptOwnOfferNotAllowed
    );
    require!(
        ctx.accounts.seller_nft_ata.amount == 1,
        Error::InvalidNftAmount
    );

    let price = ctx.accounts.offer.price;
    require!(price > 0, Error::InvalidOfferPrice);
    require!(
        ctx.accounts.offer.to_account_info().lamports() >= price,
        Error::InsufficientFunds
    );

    // --- Transfer NFT from seller ATA to buyer ATA ---
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.seller_nft_ata.to_account_info(),
                to: ctx.accounts.buyer_nft_ata.to_account_info(),
                authority: ctx.accounts.seller.to_account_info(),
            },
        ),
        1,
    )?;

    // --- Release escrowed SOL from offer PDA to seller ---
    **ctx
        .accounts
        .offer
        .to_account_info()
        .try_borrow_mut_lamports()? -= price;
    **ctx.accounts.seller.try_borrow_mut_lamports()? += price;

    // Offer account will be closed automatically via `close = buyer`
    Ok(())
}
