use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, CloseAccount, Mint, Token, TokenAccount, Transfer};

use crate::errors::Error;
use crate::state::Listing;

// -------------------------------
// Accounts
// -------------------------------

#[derive(Accounts)]
pub struct List<'info> {
    /// The NFT owner listing the NFT for sale.
    #[account(mut)]
    pub seller: Signer<'info>,

    /// The mint of the NFT being listed.
    pub mint: Account<'info, Mint>,

    /// Listing PDA: seeds = ["listing", mint]
    /// - Stores sale info (seller, mint, price, bump)
    #[account(
        init,
        payer = seller,
        space = 8 + Listing::INIT_SPACE,
        seeds = [Listing::SEED_PREFIX, mint.key().as_ref()],
        bump
    )]
    pub listing: Account<'info, Listing>,

    /// Seller's ATA holding the NFT (must be the associated token account for `mint` and `seller`).
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = seller
    )]
    pub seller_nft_ata: Account<'info, TokenAccount>,

    /// Escrow ATA owned by listing PDA; holds the NFT during listing.
    /// `init_if_needed` prevents DoS via pre-created ATA.
    #[account(
        init_if_needed,
        payer = seller,
        associated_token::mint = mint,
        associated_token::authority = listing
    )]
    pub escrow_nft_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Cancel<'info> {
    /// Seller cancels their listing.
    #[account(mut)]
    pub seller: Signer<'info>,

    pub mint: Account<'info, Mint>,

    /// Listing PDA must match seeds and must belong to this seller/mint pair.
    #[account(
        mut,
        seeds = [Listing::SEED_PREFIX, mint.key().as_ref()],
        bump = listing.bump,
        has_one = seller,
        has_one = mint,
        close = seller
    )]
    pub listing: Account<'info, Listing>,

    /// Seller's ATA that will receive the NFT back.
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = seller
    )]
    pub seller_nft_ata: Account<'info, TokenAccount>,

    /// Escrow ATA owned by listing PDA (must be the exact ATA for mint+listing PDA).
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = listing
    )]
    pub escrow_nft_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Buy<'info> {
    /// Buyer paying SOL and receiving the NFT.
    #[account(mut)]
    pub buyer: Signer<'info>,

    /// Seller receiving SOL + rent refunds from close.
    /// CHECK: verified via `listing.has_one = seller`
    #[account(mut)]
    pub seller: UncheckedAccount<'info>,

    pub mint: Account<'info, Mint>,

    #[account(
        mut,
        seeds = [Listing::SEED_PREFIX, mint.key().as_ref()],
        bump = listing.bump,
        has_one = seller,
        has_one = mint,
        close = seller
    )]
    pub listing: Account<'info, Listing>,

    /// Escrow ATA owned by listing PDA holding the NFT.
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = listing
    )]
    pub escrow_nft_ata: Account<'info, TokenAccount>,

    /// Buyer's ATA receiving the NFT.
    #[account(
        init_if_needed,
        payer = buyer,
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

pub fn list(ctx: Context<List>, price: u64) -> Result<()> {
    // --- Validations ---
    require!(price > 0, Error::InvalidPrice);
    require!(ctx.accounts.mint.decimals == 0, Error::InvalidMintDecimals);
    require!(ctx.accounts.mint.supply == 1, Error::InvalidMintSupply);
    require!(
        ctx.accounts.mint.mint_authority.is_none(),
        Error::InvalidMintAuthority
    );
    require!(
        ctx.accounts.mint.freeze_authority.is_none(),
        Error::InvalidFreezeAuthority
    );
    require!(
        ctx.accounts.seller_nft_ata.amount == 1,
        Error::InvalidNftAmount
    );

    // --- Store listing state ---
    let listing = &mut ctx.accounts.listing;
    listing.seller = ctx.accounts.seller.key();
    listing.mint = ctx.accounts.mint.key();
    listing.price = price;
    listing.bump = ctx.bumps.listing;

    // --- Move NFT from seller ATA into escrow ATA ---
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.seller_nft_ata.to_account_info(),
                to: ctx.accounts.escrow_nft_ata.to_account_info(),
                authority: ctx.accounts.seller.to_account_info(),
            },
        ),
        1,
    )?;

    Ok(())
}

pub fn cancel(ctx: Context<Cancel>) -> Result<()> {
    // --- Validations ---
    require!(
        ctx.accounts.escrow_nft_ata.amount == 1,
        Error::InvalidEscrowAmount
    );

    // --- PDA signer seeds for listing PDA authority ---
    let mint_key = ctx.accounts.mint.key();
    let bump = ctx.accounts.listing.bump;
    let signer_seeds: &[&[u8]] = &[Listing::SEED_PREFIX, mint_key.as_ref(), &[bump]];

    // --- Transfer NFT back to seller ---
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.escrow_nft_ata.to_account_info(),
                to: ctx.accounts.seller_nft_ata.to_account_info(),
                authority: ctx.accounts.listing.to_account_info(),
            },
            &[signer_seeds],
        ),
        1,
    )?;

    // --- Close escrow ATA (refund rent to seller) ---
    token::close_account(CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        CloseAccount {
            account: ctx.accounts.escrow_nft_ata.to_account_info(),
            destination: ctx.accounts.seller.to_account_info(),
            authority: ctx.accounts.listing.to_account_info(),
        },
        &[signer_seeds],
    ))?;

    // Listing account will be closed automatically via `close = seller`
    Ok(())
}

pub fn buy(ctx: Context<Buy>) -> Result<()> {
    // --- Validations ---
    require!(
        ctx.accounts.buyer.key() != ctx.accounts.seller.key(),
        Error::SelfBuyNotAllowed
    );
    require!(ctx.accounts.listing.price > 0, Error::InvalidPrice);
    require!(
        ctx.accounts.escrow_nft_ata.amount == 1,
        Error::InvalidEscrowAmount
    );

    // --- Ensure buyer has enough lamports to pay ---
    let price = ctx.accounts.listing.price;
    require!(
        ctx.accounts.buyer.lamports() >= price,
        Error::InsufficientFunds
    );

    // --- Transfer SOL from buyer to seller (explicit system transfer) ---
    let ix = anchor_lang::solana_program::system_instruction::transfer(
        &ctx.accounts.buyer.key(),
        &ctx.accounts.seller.key(),
        price,
    );
    anchor_lang::solana_program::program::invoke(
        &ix,
        &[
            ctx.accounts.buyer.to_account_info(),
            ctx.accounts.seller.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
        ],
    )?;

    // --- PDA signer seeds for listing PDA authority ---
    let mint_key = ctx.accounts.mint.key();
    let bump = ctx.accounts.listing.bump;
    let signer_seeds: &[&[u8]] = &[Listing::SEED_PREFIX, mint_key.as_ref(), &[bump]];

    // --- Transfer NFT from escrow to buyer ---
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.escrow_nft_ata.to_account_info(),
                to: ctx.accounts.buyer_nft_ata.to_account_info(),
                authority: ctx.accounts.listing.to_account_info(),
            },
            &[signer_seeds],
        ),
        1,
    )?;

    // --- Close escrow ATA (refund rent to seller) ---
    token::close_account(CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        CloseAccount {
            account: ctx.accounts.escrow_nft_ata.to_account_info(),
            destination: ctx.accounts.seller.to_account_info(),
            authority: ctx.accounts.listing.to_account_info(),
        },
        &[signer_seeds],
    ))?;

    // Listing account will be closed automatically via `close = seller`
    Ok(())
}
