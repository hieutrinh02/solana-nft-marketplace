import * as anchor from "@coral-xyz/anchor";
import {
    ASSOCIATED_TOKEN_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    getAccount,
    getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";
import { Keypair, LAMPORTS_PER_SOL, SystemProgram } from "@solana/web3.js";
import { assert } from "chai";

import {
    airdrop,
    connection,
    deriveEscrowAta,
    deriveListingPda,
    deriveMetadataPda,
    program,
    setup,
} from "./helpers";

describe("solana_nft_marketplace_program: trade", () => {
    // -------------------------------
    // Happy paths
    // -------------------------------

    it("list: moves NFT into escrow and creates listing", async () => {
        // Setup
        const { seller, mint, sellerAta, metadata } = await setup();
        const priceLamports = Math.floor(0.2 * LAMPORTS_PER_SOL);
        const price = new anchor.BN(priceLamports);

        const [listingPda, bump] = deriveListingPda(mint);
        const escrowAta = await deriveEscrowAta(mint, listingPda);

        // Interact
        await (program.methods as any)
            .list(price)
            .accounts({
                seller: seller.publicKey,
                mint,
                listing: listingPda,
                sellerNftAta: sellerAta,
                escrowNftAta: escrowAta,
                metadata,
                tokenProgram: TOKEN_PROGRAM_ID,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
            })
            .signers([seller])
            .rpc();

        // Assert
        const listing = await program.account.listing.fetch(listingPda);
        const sellerAtaAccount = await getAccount(connection, sellerAta);
        const escrowAtaAccount = await getAccount(connection, escrowAta);

        assert.equal(listing.seller.toString(), seller.publicKey.toString());
        assert.equal(listing.mint.toString(), mint.toString());
        assert.equal(listing.price.toString(), price.toString());
        assert.equal(listing.bump, bump);
        assert.equal(sellerAtaAccount.amount.toString(), "0");
        assert.equal(escrowAtaAccount.amount.toString(), "1");
    });

    it("cancel: returns NFT, closes escrow and listing", async () => {
        // Setup
        const { seller, mint, sellerAta, metadata } = await setup();
        const priceLamports = Math.floor(0.2 * LAMPORTS_PER_SOL);
        const price = new anchor.BN(priceLamports);

        const [listingPda] = deriveListingPda(mint);
        const escrowAta = await deriveEscrowAta(mint, listingPda);

        // Interact
        await (program.methods as any)
            .list(price)
            .accounts({
                seller: seller.publicKey,
                mint,
                listing: listingPda,
                sellerNftAta: sellerAta,
                escrowNftAta: escrowAta,
                metadata,
                tokenProgram: TOKEN_PROGRAM_ID,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
            })
            .signers([seller])
            .rpc();

        await (program.methods as any)
            .cancel()
            .accounts({
                seller: seller.publicKey,
                mint,
                listing: listingPda,
                sellerNftAta: sellerAta,
                escrowNftAta: escrowAta,
                tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([seller])
            .rpc();

        // Assert
        const sellerAtaAccount = await getAccount(connection, sellerAta);
        assert.equal(sellerAtaAccount.amount.toString(), "1");

        // Escrow ATA should be closed
        try {
            await getAccount(connection, escrowAta);
            assert.fail("escrow ata should be closed");
        } catch (_) {
            // expected
        }

        // Listing should be closed
        try {
            await program.account.listing.fetch(listingPda);
            assert.fail("listing account should be closed");
        } catch {
            // expected
        }
    });

    it("buy: transfers SOL and NFT, closes escrow and listing", async () => {
        // Setup
        const { seller, buyer, mint, sellerAta, buyerAta, metadata } = await setup();
        const priceLamports = Math.floor(0.2 * LAMPORTS_PER_SOL);
        const price = new anchor.BN(priceLamports);

        const [listingPda] = deriveListingPda(mint);
        const escrowAta = await deriveEscrowAta(mint, listingPda);

        // Interact
        await (program.methods as any)
            .list(price)
            .accounts({
                seller: seller.publicKey,
                mint,
                listing: listingPda,
                sellerNftAta: sellerAta,
                escrowNftAta: escrowAta,
                metadata,
                tokenProgram: TOKEN_PROGRAM_ID,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
            })
            .signers([seller])
            .rpc();

        const sellerLamportsBefore = await connection.getBalance(seller.publicKey);
        const buyerLamportsBefore = await connection.getBalance(buyer.publicKey);

        await (program.methods as any)
            .buy()
            .accounts({
                buyer: buyer.publicKey,
                seller: seller.publicKey,
                mint,
                listing: listingPda,
                escrowNftAta: escrowAta,
                buyerNftAta: buyerAta,
                tokenProgram: TOKEN_PROGRAM_ID,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
            })
            .signers([buyer])
            .rpc();

        // Assert
        const buyerAtaAccount = await getAccount(connection, buyerAta);
        assert.equal(buyerAtaAccount.amount.toString(), "1");

        // Escrow ATA should be closed
        try {
            await getAccount(connection, escrowAta);
            assert.fail("escrow ata should be closed");
        } catch (_) {
            // expected
        }

        // Listing should be closed
        try {
            await program.account.listing.fetch(listingPda);
            assert.fail("listing account should be closed");
        } catch {
            // expected
        }

        const sellerLamportsAfter = await connection.getBalance(seller.publicKey);
        const buyerLamportsAfter = await connection.getBalance(buyer.publicKey);

        assert.isAtLeast(sellerLamportsAfter - sellerLamportsBefore, priceLamports);
        assert.isAtLeast(buyerLamportsBefore - buyerLamportsAfter, priceLamports);
    });

    // -------------------------------
    // Failure tests: list()
    // -------------------------------

    it("list: fails if listing PDA already exists for same mint", async () => {
        // Setup
        const { seller, mint, sellerAta, metadata } = await setup();
        const priceLamports = Math.floor(0.2 * LAMPORTS_PER_SOL);
        const price = new anchor.BN(priceLamports);

        const [listingPda] = deriveListingPda(mint);
        const escrowAta = await deriveEscrowAta(mint, listingPda);

        await (program.methods as any)
            .list(price)
            .accounts({
                seller: seller.publicKey,
                mint,
                listing: listingPda,
                sellerNftAta: sellerAta,
                escrowNftAta: escrowAta,
                metadata,
                tokenProgram: TOKEN_PROGRAM_ID,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
            })
            .signers([seller])
            .rpc();

        // Interact
        try {
            await (program.methods as any)
                .list(price)
                .accounts({
                    seller: seller.publicKey,
                    mint,
                    listing: listingPda,
                    sellerNftAta: sellerAta,
                    escrowNftAta: escrowAta,
                    metadata,
                    tokenProgram: TOKEN_PROGRAM_ID,
                    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                    systemProgram: SystemProgram.programId,
                })
                .signers([seller])
                .rpc();

            assert.fail("listing the same mint twice should fail");
        } catch (err: any) {
            // Assert
            assert.include(err.toString().toLowerCase(), "already in use");
        }
    });

    it("list: fails if seller ATA is invalid", async () => {
        // Setup
        const { seller, mint, buyerAta, metadata } = await setup();
        const priceLamports = Math.floor(0.2 * LAMPORTS_PER_SOL);
        const price = new anchor.BN(priceLamports);

        const [listingPda] = deriveListingPda(mint);
        const escrowAta = await deriveEscrowAta(mint, listingPda);

        // Interact
        try {
            await (program.methods as any)
                .list(price)
                .accounts({
                    seller: seller.publicKey,
                    mint,
                    listing: listingPda,
                    sellerNftAta: buyerAta,
                    escrowNftAta: escrowAta,
                    metadata,
                    tokenProgram: TOKEN_PROGRAM_ID,
                    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                    systemProgram: SystemProgram.programId,
                })
                .signers([seller])
                .rpc();

            assert.fail("listing with an invalid seller ATA should fail");
        } catch (err: any) {
            // Assert
            assert.equal(err?.error?.errorCode?.code, "ConstraintTokenOwner");
        }
    });

    it("list: fails if escrow ATA is invalid", async () => {
        // Setup
        const { seller, mint, sellerAta, buyerAta, metadata } = await setup();
        const priceLamports = Math.floor(0.2 * LAMPORTS_PER_SOL);
        const price = new anchor.BN(priceLamports);

        const [listingPda] = deriveListingPda(mint);

        // Interact
        try {
            await (program.methods as any)
                .list(price)
                .accounts({
                    seller: seller.publicKey,
                    mint,
                    listing: listingPda,
                    sellerNftAta: sellerAta,
                    escrowNftAta: buyerAta,
                    metadata,
                    tokenProgram: TOKEN_PROGRAM_ID,
                    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                    systemProgram: SystemProgram.programId,
                })
                .signers([seller])
                .rpc();

            assert.fail("listing with an invalid escrow ATA should fail");
        } catch (err: any) {
            // Assert
            assert.equal(err?.error?.errorCode?.code, "ConstraintTokenOwner");
        }
    });

    it("list: fails when price is 0", async () => {
        // Setup
        const { seller, mint, sellerAta, metadata } = await setup();
        const [listingPda] = deriveListingPda(mint);
        const escrowAta = await deriveEscrowAta(mint, listingPda);

        // Interact
        try {
            await (program.methods as any)
                .list(new anchor.BN(0))
                .accounts({
                    seller: seller.publicKey,
                    mint,
                    listing: listingPda,
                    sellerNftAta: sellerAta,
                    escrowNftAta: escrowAta,
                    metadata,
                    tokenProgram: TOKEN_PROGRAM_ID,
                    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                    systemProgram: SystemProgram.programId,
                })
                .signers([seller])
                .rpc();

            assert.fail("listing with price 0 should fail");
        } catch (err: any) {
            // Assert
            assert.equal(err?.error?.errorCode?.code, "InvalidListingPrice");
        }
    });

    it("list: fails when seller ATA has no NFT", async () => {
        // Setup
        const { buyer, mint, buyerAta, metadata } = await setup();
        const priceLamports = Math.floor(0.2 * LAMPORTS_PER_SOL);
        const price = new anchor.BN(priceLamports);

        const [listingPda] = deriveListingPda(mint);
        const escrowAta = await deriveEscrowAta(mint, listingPda);

        // Interact
        try {
            await (program.methods as any)
                .list(price)
                .accounts({
                    seller: buyer.publicKey,
                    mint,
                    listing: listingPda,
                    sellerNftAta: buyerAta,
                    escrowNftAta: escrowAta,
                    metadata,
                    tokenProgram: TOKEN_PROGRAM_ID,
                    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                    systemProgram: SystemProgram.programId,
                })
                .signers([buyer])
                .rpc();

            assert.fail("listing without owning the NFT should fail");
        } catch (err: any) {
            // Assert
            assert.equal(err?.error?.errorCode?.code, "InvalidNftAmount");
        }
    });

    it("list: fails if metadata owner is invalid", async () => {
        // Setup
        const { seller, mint, sellerAta } = await setup();
        const priceLamports = Math.floor(0.2 * LAMPORTS_PER_SOL);
        const price = new anchor.BN(priceLamports);

        const [listingPda] = deriveListingPda(mint);
        const escrowAta = await deriveEscrowAta(mint, listingPda);

        // Interact
        try {
            await (program.methods as any)
                .list(price)
                .accounts({
                    seller: seller.publicKey,
                    mint,
                    listing: listingPda,
                    sellerNftAta: sellerAta,
                    escrowNftAta: escrowAta,
                    metadata: seller.publicKey,
                    tokenProgram: TOKEN_PROGRAM_ID,
                    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                    systemProgram: SystemProgram.programId,
                })
                .signers([seller])
                .rpc();

            assert.fail("listing with metadata owned by the wrong program should fail");
        } catch (err: any) {
            // Assert
            assert.equal(err?.error?.errorCode?.code, "InvalidMetadataOwner");
        }
    });

    it("list: fails if metadata PDA is invalid", async () => {
        // Setup
        const { seller, mint, sellerAta, collectionMint } = await setup();
        const priceLamports = Math.floor(0.2 * LAMPORTS_PER_SOL);
        const price = new anchor.BN(priceLamports);

        const [listingPda] = deriveListingPda(mint);
        const escrowAta = await deriveEscrowAta(mint, listingPda);
        const [wrongMetadata] = deriveMetadataPda(collectionMint);

        // Interact
        try {
            await (program.methods as any)
                .list(price)
                .accounts({
                    seller: seller.publicKey,
                    mint,
                    listing: listingPda,
                    sellerNftAta: sellerAta,
                    escrowNftAta: escrowAta,
                    metadata: wrongMetadata,
                    tokenProgram: TOKEN_PROGRAM_ID,
                    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                    systemProgram: SystemProgram.programId,
                })
                .signers([seller])
                .rpc();

            assert.fail("listing with the wrong metadata PDA should fail");
        } catch (err: any) {
            // Assert
            assert.equal(err?.error?.errorCode?.code, "InvalidMetadataAccount");
        }
    });

    // -------------------------------
    // Failure tests: cancel()
    // -------------------------------

    it("cancel: fails on second cancel after listing is closed", async () => {
        // Setup
        const { seller, mint, sellerAta, metadata } = await setup();
        const priceLamports = Math.floor(0.2 * LAMPORTS_PER_SOL);
        const price = new anchor.BN(priceLamports);

        const [listingPda] = deriveListingPda(mint);
        const escrowAta = await deriveEscrowAta(mint, listingPda);

        await (program.methods as any)
            .list(price)
            .accounts({
                seller: seller.publicKey,
                mint,
                listing: listingPda,
                sellerNftAta: sellerAta,
                escrowNftAta: escrowAta,
                metadata,
                tokenProgram: TOKEN_PROGRAM_ID,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
            })
            .signers([seller])
            .rpc();

        await (program.methods as any)
            .cancel()
            .accounts({
                seller: seller.publicKey,
                mint,
                listing: listingPda,
                sellerNftAta: sellerAta,
                escrowNftAta: escrowAta,
                tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([seller])
            .rpc();

        // Interact
        try {
            await (program.methods as any)
                .cancel()
                .accounts({
                    seller: seller.publicKey,
                    mint,
                    listing: listingPda,
                    sellerNftAta: sellerAta,
                    escrowNftAta: escrowAta,
                    tokenProgram: TOKEN_PROGRAM_ID,
                })
                .signers([seller])
                .rpc();

            assert.fail("canceling a closed listing should fail");
        } catch (err: any) {
            // Assert
            assert.equal(err?.error?.errorCode?.code, "AccountNotInitialized");
        }
    });

    it("cancel: fails if not seller", async () => {
        // Setup
        const { seller, buyer, mint, sellerAta, metadata } = await setup();
        const priceLamports = Math.floor(0.2 * LAMPORTS_PER_SOL);
        const price = new anchor.BN(priceLamports);

        const [listingPda] = deriveListingPda(mint);
        const escrowAta = await deriveEscrowAta(mint, listingPda);

        await (program.methods as any)
            .list(price)
            .accounts({
                seller: seller.publicKey,
                mint,
                listing: listingPda,
                sellerNftAta: sellerAta,
                escrowNftAta: escrowAta,
                metadata,
                tokenProgram: TOKEN_PROGRAM_ID,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
            })
            .signers([seller])
            .rpc();

        // Interact
        try {
            await (program.methods as any)
                .cancel()
                .accounts({
                    seller: buyer.publicKey,
                    mint,
                    listing: listingPda,
                    sellerNftAta: sellerAta,
                    escrowNftAta: escrowAta,
                    tokenProgram: TOKEN_PROGRAM_ID,
                })
                .signers([buyer])
                .rpc();

            assert.fail("canceling by a non-seller should fail");
        } catch (err: any) {
            // Assert
            assert.equal(err?.error?.errorCode?.code, "ConstraintHasOne");
        }
    });

    it("cancel: fails if wrong mint is provided", async () => {
        // Setup
        const { seller, mint, sellerAta, metadata, collectionMint } = await setup();
        const priceLamports = Math.floor(0.2 * LAMPORTS_PER_SOL);
        const price = new anchor.BN(priceLamports);

        const [listingPda] = deriveListingPda(mint);
        const escrowAta = await deriveEscrowAta(mint, listingPda);

        await (program.methods as any)
            .list(price)
            .accounts({
                seller: seller.publicKey,
                mint,
                listing: listingPda,
                sellerNftAta: sellerAta,
                escrowNftAta: escrowAta,
                metadata,
                tokenProgram: TOKEN_PROGRAM_ID,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
            })
            .signers([seller])
            .rpc();

        // Interact
        try {
            await (program.methods as any)
                .cancel()
                .accounts({
                    seller: seller.publicKey,
                    mint: collectionMint,
                    listing: listingPda,
                    sellerNftAta: sellerAta,
                    escrowNftAta: escrowAta,
                    tokenProgram: TOKEN_PROGRAM_ID,
                })
                .signers([seller])
                .rpc();

            assert.fail("canceling with the wrong mint should fail");
        } catch (err: any) {
            // Assert
            assert.equal(err?.error?.errorCode?.code, "ConstraintSeeds");
        }
    });

    it("cancel: fails if seller ATA is invalid", async () => {
        // Setup
        const { seller, mint, sellerAta, buyerAta, metadata } = await setup();
        const priceLamports = Math.floor(0.2 * LAMPORTS_PER_SOL);
        const price = new anchor.BN(priceLamports);

        const [listingPda] = deriveListingPda(mint);
        const escrowAta = await deriveEscrowAta(mint, listingPda);

        await (program.methods as any)
            .list(price)
            .accounts({
                seller: seller.publicKey,
                mint,
                listing: listingPda,
                sellerNftAta: sellerAta,
                escrowNftAta: escrowAta,
                metadata,
                tokenProgram: TOKEN_PROGRAM_ID,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
            })
            .signers([seller])
            .rpc();

        // Interact
        try {
            await (program.methods as any)
                .cancel()
                .accounts({
                    seller: seller.publicKey,
                    mint,
                    listing: listingPda,
                    sellerNftAta: buyerAta,
                    escrowNftAta: escrowAta,
                    tokenProgram: TOKEN_PROGRAM_ID,
                })
                .signers([seller])
                .rpc();

            assert.fail("canceling with an invalid seller ATA should fail");
        } catch (err: any) {
            // Assert
            assert.equal(err?.error?.errorCode?.code, "ConstraintTokenOwner");
        }
    });

    it("cancel: fails if escrow ATA is invalid", async () => {
        // Setup
        const { seller, mint, sellerAta, buyerAta, metadata } = await setup();
        const priceLamports = Math.floor(0.2 * LAMPORTS_PER_SOL);
        const price = new anchor.BN(priceLamports);

        const [listingPda] = deriveListingPda(mint);
        const escrowAta = await deriveEscrowAta(mint, listingPda);

        await (program.methods as any)
            .list(price)
            .accounts({
                seller: seller.publicKey,
                mint,
                listing: listingPda,
                sellerNftAta: sellerAta,
                escrowNftAta: escrowAta,
                metadata,
                tokenProgram: TOKEN_PROGRAM_ID,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
            })
            .signers([seller])
            .rpc();

        // Interact
        try {
            await (program.methods as any)
                .cancel()
                .accounts({
                    seller: seller.publicKey,
                    mint,
                    listing: listingPda,
                    sellerNftAta: sellerAta,
                    escrowNftAta: buyerAta,
                    tokenProgram: TOKEN_PROGRAM_ID,
                })
                .signers([seller])
                .rpc();

            assert.fail("canceling with an invalid escrow ATA should fail");
        } catch (err: any) {
            // Assert
            assert.equal(err?.error?.errorCode?.code, "ConstraintTokenOwner");
        }
    });

    // -------------------------------
    // Failure tests: buy()
    // -------------------------------

    it("buy: fails on second purchase after listing is closed", async () => {
        // Setup
        const { seller, buyer, mint, sellerAta, buyerAta, metadata } = await setup();
        const priceLamports = Math.floor(0.2 * LAMPORTS_PER_SOL);
        const price = new anchor.BN(priceLamports);

        const [listingPda] = deriveListingPda(mint);
        const escrowAta = await deriveEscrowAta(mint, listingPda);

        await (program.methods as any)
            .list(price)
            .accounts({
                seller: seller.publicKey,
                mint,
                listing: listingPda,
                sellerNftAta: sellerAta,
                escrowNftAta: escrowAta,
                metadata,
                tokenProgram: TOKEN_PROGRAM_ID,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
            })
            .signers([seller])
            .rpc();

        await (program.methods as any)
            .buy()
            .accounts({
                buyer: buyer.publicKey,
                seller: seller.publicKey,
                mint,
                listing: listingPda,
                escrowNftAta: escrowAta,
                buyerNftAta: buyerAta,
                tokenProgram: TOKEN_PROGRAM_ID,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
            })
            .signers([buyer])
            .rpc();

        // Interact
        try {
            await (program.methods as any)
                .buy()
                .accounts({
                    buyer: buyer.publicKey,
                    seller: seller.publicKey,
                    mint,
                    listing: listingPda,
                    escrowNftAta: escrowAta,
                    buyerNftAta: buyerAta,
                    tokenProgram: TOKEN_PROGRAM_ID,
                    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                    systemProgram: SystemProgram.programId,
                })
                .signers([buyer])
                .rpc();

            assert.fail("buying a closed listing should fail");
        } catch (err: any) {
            // Assert
            assert.equal(err?.error?.errorCode?.code, "AccountNotInitialized");
        }
    });

    it("buy: fails if wrong seller account is provided", async () => {
        // Setup
        const { seller, buyer, mint, sellerAta, buyerAta, metadata } = await setup();
        const wrongSeller = Keypair.generate();
        const priceLamports = Math.floor(0.2 * LAMPORTS_PER_SOL);
        const price = new anchor.BN(priceLamports);

        await airdrop(wrongSeller.publicKey, 1);

        const [listingPda] = deriveListingPda(mint);
        const escrowAta = await deriveEscrowAta(mint, listingPda);

        await (program.methods as any)
            .list(price)
            .accounts({
                seller: seller.publicKey,
                mint,
                listing: listingPda,
                sellerNftAta: sellerAta,
                escrowNftAta: escrowAta,
                metadata,
                tokenProgram: TOKEN_PROGRAM_ID,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
            })
            .signers([seller])
            .rpc();

        // Interact
        try {
            await (program.methods as any)
                .buy()
                .accounts({
                    buyer: buyer.publicKey,
                    seller: wrongSeller.publicKey,
                    mint,
                    listing: listingPda,
                    escrowNftAta: escrowAta,
                    buyerNftAta: buyerAta,
                    tokenProgram: TOKEN_PROGRAM_ID,
                    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                    systemProgram: SystemProgram.programId,
                })
                .signers([buyer])
                .rpc();

            assert.fail("buying with the wrong seller account should fail");
        } catch (err: any) {
            // Assert
            assert.equal(err?.error?.errorCode?.code, "ConstraintHasOne");
        }
    });

    it("buy: fails if wrong mint is provided", async () => {
        // Setup
        const { seller, buyer, mint, sellerAta, buyerAta, metadata, collectionMint } = await setup();
        const priceLamports = Math.floor(0.2 * LAMPORTS_PER_SOL);
        const price = new anchor.BN(priceLamports);

        const [listingPda] = deriveListingPda(mint);
        const escrowAta = await deriveEscrowAta(mint, listingPda);

        await (program.methods as any)
            .list(price)
            .accounts({
                seller: seller.publicKey,
                mint,
                listing: listingPda,
                sellerNftAta: sellerAta,
                escrowNftAta: escrowAta,
                metadata,
                tokenProgram: TOKEN_PROGRAM_ID,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
            })
            .signers([seller])
            .rpc();

        // Interact
        try {
            await (program.methods as any)
                .buy()
                .accounts({
                    buyer: buyer.publicKey,
                    seller: seller.publicKey,
                    mint: collectionMint,
                    listing: listingPda,
                    escrowNftAta: escrowAta,
                    buyerNftAta: buyerAta,
                    tokenProgram: TOKEN_PROGRAM_ID,
                    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                    systemProgram: SystemProgram.programId,
                })
                .signers([buyer])
                .rpc();

            assert.fail("buying with the wrong mint should fail");
        } catch (err: any) {
            // Assert
            assert.equal(err?.error?.errorCode?.code, "ConstraintTokenMint");
        }
    });

    it("buy: fails if escrow ATA is invalid", async () => {
        // Setup
        const { seller, buyer, mint, sellerAta, buyerAta, metadata } = await setup();
        const priceLamports = Math.floor(0.2 * LAMPORTS_PER_SOL);
        const price = new anchor.BN(priceLamports);

        const [listingPda] = deriveListingPda(mint);
        const escrowAta = await deriveEscrowAta(mint, listingPda);

        await (program.methods as any)
            .list(price)
            .accounts({
                seller: seller.publicKey,
                mint,
                listing: listingPda,
                sellerNftAta: sellerAta,
                escrowNftAta: escrowAta,
                metadata,
                tokenProgram: TOKEN_PROGRAM_ID,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
            })
            .signers([seller])
            .rpc();

        // Interact
        try {
            await (program.methods as any)
                .buy()
                .accounts({
                    buyer: buyer.publicKey,
                    seller: seller.publicKey,
                    mint,
                    listing: listingPda,
                    escrowNftAta: buyerAta,
                    buyerNftAta: buyerAta,
                    tokenProgram: TOKEN_PROGRAM_ID,
                    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                    systemProgram: SystemProgram.programId,
                })
                .signers([buyer])
                .rpc();

            assert.fail("buying with an invalid escrow ATA should fail");
        } catch (err: any) {
            // Assert
            assert.equal(err?.error?.errorCode?.code, "ConstraintTokenOwner");
        }
    });

    it("buy: fails if buyer ATA is invalid", async () => {
        // Setup
        const { seller, buyer, mint, sellerAta, metadata } = await setup();
        const attacker = Keypair.generate();
        const priceLamports = Math.floor(0.2 * LAMPORTS_PER_SOL);
        const price = new anchor.BN(priceLamports);

        await airdrop(attacker.publicKey, 1);

        const attackerAta = await getOrCreateAssociatedTokenAccount(
            connection,
            attacker,
            mint,
            attacker.publicKey
        );

        const [listingPda] = deriveListingPda(mint);
        const escrowAta = await deriveEscrowAta(mint, listingPda);

        await (program.methods as any)
            .list(price)
            .accounts({
                seller: seller.publicKey,
                mint,
                listing: listingPda,
                sellerNftAta: sellerAta,
                escrowNftAta: escrowAta,
                metadata,
                tokenProgram: TOKEN_PROGRAM_ID,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
            })
            .signers([seller])
            .rpc();

        // Interact
        try {
            await (program.methods as any)
                .buy()
                .accounts({
                    buyer: buyer.publicKey,
                    seller: seller.publicKey,
                    mint,
                    listing: listingPda,
                    escrowNftAta: escrowAta,
                    buyerNftAta: attackerAta.address,
                    tokenProgram: TOKEN_PROGRAM_ID,
                    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                    systemProgram: SystemProgram.programId,
                })
                .signers([buyer])
                .rpc();

            assert.fail("buying with an invalid buyer ATA should fail");
        } catch (err: any) {
            // Assert
            assert.equal(err?.error?.errorCode?.code, "ConstraintTokenOwner");
        }
    });

    it("buy: fails if buyer tries to buy their own listing", async () => {
        // Setup
        const { seller, mint, sellerAta, metadata } = await setup();
        const priceLamports = Math.floor(0.2 * LAMPORTS_PER_SOL);
        const price = new anchor.BN(priceLamports);

        const [listingPda] = deriveListingPda(mint);
        const escrowAta = await deriveEscrowAta(mint, listingPda);

        await (program.methods as any)
            .list(price)
            .accounts({
                seller: seller.publicKey,
                mint,
                listing: listingPda,
                sellerNftAta: sellerAta,
                escrowNftAta: escrowAta,
                metadata,
                tokenProgram: TOKEN_PROGRAM_ID,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
            })
            .signers([seller])
            .rpc();

        // Interact
        try {
            await (program.methods as any)
                .buy()
                .accounts({
                    buyer: seller.publicKey,
                    seller: seller.publicKey,
                    mint,
                    listing: listingPda,
                    escrowNftAta: escrowAta,
                    buyerNftAta: sellerAta,
                    tokenProgram: TOKEN_PROGRAM_ID,
                    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                    systemProgram: SystemProgram.programId,
                })
                .signers([seller])
                .rpc();

            assert.fail("self-buying should fail");
        } catch (err: any) {
            // Assert
            assert.equal(err?.error?.errorCode?.code, "BuyOwnListingNotAllowed");
        }
    });

    it("buy: fails when buyer has insufficient funds", async () => {
        // Setup
        const { seller, mint, sellerAta, metadata } = await setup();
        const poorBuyer = Keypair.generate();
        const priceLamports = 3 * LAMPORTS_PER_SOL;
        const price = new anchor.BN(priceLamports);

        await airdrop(poorBuyer.publicKey, 0.01);

        const poorBuyerAta = await getOrCreateAssociatedTokenAccount(
            connection,
            poorBuyer,
            mint,
            poorBuyer.publicKey,
        );

        const [listingPda] = deriveListingPda(mint);
        const escrowAta = await deriveEscrowAta(mint, listingPda);

        await (program.methods as any)
            .list(price)
            .accounts({
                seller: seller.publicKey,
                mint,
                listing: listingPda,
                sellerNftAta: sellerAta,
                escrowNftAta: escrowAta,
                metadata,
                tokenProgram: TOKEN_PROGRAM_ID,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
            })
            .signers([seller])
            .rpc();

        // Interact
        try {
            await (program.methods as any)
                .buy()
                .accounts({
                    buyer: poorBuyer.publicKey,
                    seller: seller.publicKey,
                    mint,
                    listing: listingPda,
                    escrowNftAta: escrowAta,
                    buyerNftAta: poorBuyerAta.address,
                    tokenProgram: TOKEN_PROGRAM_ID,
                    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                    systemProgram: SystemProgram.programId,
                })
                .signers([poorBuyer])
                .rpc();

            assert.fail("buying without enough SOL should fail");
        } catch (err: any) {
            // Assert
            assert.equal(err?.error?.errorCode?.code, "InsufficientFunds");
        }
    });
});
