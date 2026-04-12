import * as anchor from "@coral-xyz/anchor";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, getAccount, getOrCreateAssociatedTokenAccount } from "@solana/spl-token";
import { Keypair, LAMPORTS_PER_SOL, SystemProgram } from "@solana/web3.js";
import { assert } from "chai";

import {
    airdrop,
    connection,
    deriveMetadataPda,
    deriveOfferPda,
    program,
    setup,
} from "./helpers";

describe("solana_nft_marketplace_program: offer", () => {
    // -------------------------------
    // Happy paths
    // -------------------------------

    it("make_offer: escrows SOL and creates offer", async () => {
        // Setup
        const { buyer, mint, metadata } = await setup();
        const priceLamports = Math.floor(0.2 * LAMPORTS_PER_SOL);
        const price = new anchor.BN(priceLamports);

        const [offerPda, bump] = deriveOfferPda(buyer.publicKey, mint);
        const buyerLamportsBefore = await connection.getBalance(buyer.publicKey);

        // Interact
        await (program.methods as any)
            .makeOffer(price)
            .accounts({
                buyer: buyer.publicKey,
                mint,
                offer: offerPda,
                metadata,
                systemProgram: SystemProgram.programId,
            })
            .signers([buyer])
            .rpc();

        // Assert
        const offer = await program.account.offer.fetch(offerPda);
        const buyerLamportsAfter = await connection.getBalance(buyer.publicKey);
        const offerLamports = await connection.getBalance(offerPda);

        assert.equal(offer.buyer.toString(), buyer.publicKey.toString());
        assert.equal(offer.mint.toString(), mint.toString());
        assert.equal(offer.price.toString(), price.toString());
        assert.equal(offer.bump, bump);
        assert.isAtLeast(offerLamports, priceLamports);
        assert.isAtLeast(buyerLamportsBefore - buyerLamportsAfter, priceLamports);
    });

    it("cancel_offer: refunds SOL to buyer and closes offer", async () => {
        // Setup
        const { buyer, mint, metadata } = await setup();
        const priceLamports = Math.floor(0.2 * LAMPORTS_PER_SOL);
        const price = new anchor.BN(priceLamports);

        const [offerPda] = deriveOfferPda(buyer.publicKey, mint);

        await (program.methods as any)
            .makeOffer(price)
            .accounts({
                buyer: buyer.publicKey,
                mint,
                offer: offerPda,
                metadata,
                systemProgram: SystemProgram.programId,
            })
            .signers([buyer])
            .rpc();

        const buyerLamportsBefore = await connection.getBalance(buyer.publicKey);

        // Interact
        await (program.methods as any)
            .cancelOffer()
            .accounts({
                buyer: buyer.publicKey,
                mint,
                offer: offerPda,
            })
            .signers([buyer])
            .rpc();

        // Assert
        const buyerLamportsAfter = await connection.getBalance(buyer.publicKey);
        assert.isAtLeast(buyerLamportsAfter - buyerLamportsBefore, priceLamports);

        // Offer should be closed
        try {
            await program.account.offer.fetch(offerPda);
            assert.fail("offer account should be closed");
        } catch {
            // expected
        }
    });

    it("accept_offer: transfers NFT to buyer, releases SOL to seller, and closes offer", async () => {
        // Setup
        const { seller, buyer, mint, sellerAta, buyerAta, metadata } = await setup();
        const priceLamports = Math.floor(0.2 * LAMPORTS_PER_SOL);
        const price = new anchor.BN(priceLamports);

        const [offerPda] = deriveOfferPda(buyer.publicKey, mint);

        await (program.methods as any)
            .makeOffer(price)
            .accounts({
                buyer: buyer.publicKey,
                mint,
                offer: offerPda,
                metadata,
                systemProgram: SystemProgram.programId,
            })
            .signers([buyer])
            .rpc();

        const sellerLamportsBefore = await connection.getBalance(seller.publicKey);
        const buyerLamportsBefore = await connection.getBalance(buyer.publicKey);

        // Interact
        await (program.methods as any)
            .acceptOffer()
            .accounts({
                seller: seller.publicKey,
                buyer: buyer.publicKey,
                mint,
                offer: offerPda,
                sellerNftAta: sellerAta,
                buyerNftAta: buyerAta,
                tokenProgram: TOKEN_PROGRAM_ID,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
            })
            .signers([seller])
            .rpc();

        // Assert
        const sellerAtaAccount = await getAccount(connection, sellerAta);
        const buyerAtaAccount = await getAccount(connection, buyerAta);
        const sellerLamportsAfter = await connection.getBalance(seller.publicKey);
        const buyerLamportsAfter = await connection.getBalance(buyer.publicKey);

        assert.equal(sellerAtaAccount.amount.toString(), "0");
        assert.equal(buyerAtaAccount.amount.toString(), "1");
        assert.isAtLeast(sellerLamportsAfter - sellerLamportsBefore, priceLamports);
        assert.isAtLeast(buyerLamportsAfter, buyerLamportsBefore);

        // Offer should be closed
        try {
            await program.account.offer.fetch(offerPda);
            assert.fail("offer account should be closed");
        } catch {
            // expected
        }
    });

    // -------------------------------
    // Failure tests: make_offer()
    // -------------------------------

    it("make_offer: fails if offer PDA already exists for the same buyer and mint", async () => {
        // Setup
        const { buyer, mint, metadata } = await setup();
        const priceLamports = Math.floor(0.2 * LAMPORTS_PER_SOL);
        const price = new anchor.BN(priceLamports);

        const [offerPda] = deriveOfferPda(buyer.publicKey, mint);

        await (program.methods as any)
            .makeOffer(price)
            .accounts({
                buyer: buyer.publicKey,
                mint,
                offer: offerPda,
                metadata,
                systemProgram: SystemProgram.programId,
            })
            .signers([buyer])
            .rpc();

        // Interact
        try {
            await (program.methods as any)
                .makeOffer(price)
                .accounts({
                    buyer: buyer.publicKey,
                    mint,
                    offer: offerPda,
                    metadata,
                    systemProgram: SystemProgram.programId,
                })
                .signers([buyer])
                .rpc();

            assert.fail("making the same offer twice should fail");
        } catch (err: any) {
            // Assert
            assert.include(err.toString().toLowerCase(), "already in use");
        }
    });

    it("make_offer: fails when price is 0", async () => {
        // Setup
        const { buyer, mint, metadata } = await setup();
        const [offerPda] = deriveOfferPda(buyer.publicKey, mint);

        // Interact
        try {
            await (program.methods as any)
                .makeOffer(new anchor.BN(0))
                .accounts({
                    buyer: buyer.publicKey,
                    mint,
                    offer: offerPda,
                    metadata,
                    systemProgram: SystemProgram.programId,
                })
                .signers([buyer])
                .rpc();

            assert.fail("making an offer with price 0 should fail");
        } catch (err: any) {
            // Assert
            assert.equal(err?.error?.errorCode?.code, "InvalidOfferPrice");
        }
    });

    it("make_offer: fails when buyer has insufficient funds", async () => {
        // Setup
        const { mint, metadata } = await setup();
        const poorBuyer = Keypair.generate();
        const priceLamports = 3 * LAMPORTS_PER_SOL;
        const price = new anchor.BN(priceLamports);

        await airdrop(poorBuyer.publicKey, 0.01);

        const [offerPda] = deriveOfferPda(poorBuyer.publicKey, mint);

        // Interact
        try {
            await (program.methods as any)
                .makeOffer(price)
                .accounts({
                    buyer: poorBuyer.publicKey,
                    mint,
                    offer: offerPda,
                    metadata,
                    systemProgram: SystemProgram.programId,
                })
                .signers([poorBuyer])
                .rpc();

            assert.fail("making an offer without enough SOL should fail");
        } catch (err: any) {
            // Assert
            assert.equal(err?.error?.errorCode?.code, "InsufficientFunds");
        }
    });

    it("make_offer: fails if metadata owner is invalid", async () => {
        // Setup
        const { buyer, mint } = await setup();
        const priceLamports = Math.floor(0.2 * LAMPORTS_PER_SOL);
        const price = new anchor.BN(priceLamports);

        const [offerPda] = deriveOfferPda(buyer.publicKey, mint);

        // Interact
        try {
            await (program.methods as any)
                .makeOffer(price)
                .accounts({
                    buyer: buyer.publicKey,
                    mint,
                    offer: offerPda,
                    metadata: buyer.publicKey,
                    systemProgram: SystemProgram.programId,
                })
                .signers([buyer])
                .rpc();

            assert.fail("making an offer with metadata owned by the wrong program should fail");
        } catch (err: any) {
            // Assert
            assert.equal(err?.error?.errorCode?.code, "InvalidMetadataOwner");
        }
    });

    it("make_offer: fails if metadata PDA is invalid", async () => {
        // Setup
        const { buyer, mint, collectionMint } = await setup();
        const priceLamports = Math.floor(0.2 * LAMPORTS_PER_SOL);
        const price = new anchor.BN(priceLamports);

        const [offerPda] = deriveOfferPda(buyer.publicKey, mint);
        const [wrongMetadata] = deriveMetadataPda(collectionMint);

        // Interact
        try {
            await (program.methods as any)
                .makeOffer(price)
                .accounts({
                    buyer: buyer.publicKey,
                    mint,
                    offer: offerPda,
                    metadata: wrongMetadata,
                    systemProgram: SystemProgram.programId,
                })
                .signers([buyer])
                .rpc();

            assert.fail("making an offer with the wrong metadata PDA should fail");
        } catch (err: any) {
            // Assert
            assert.equal(err?.error?.errorCode?.code, "InvalidMetadataAccount");
        }
    });

    // -------------------------------
    // Failure tests: cancel_offer()
    // -------------------------------

    it("cancel_offer: fails on second cancel after offer is closed", async () => {
        // Setup
        const { buyer, mint, metadata } = await setup();
        const priceLamports = Math.floor(0.2 * LAMPORTS_PER_SOL);
        const price = new anchor.BN(priceLamports);

        const [offerPda] = deriveOfferPda(buyer.publicKey, mint);

        await (program.methods as any)
            .makeOffer(price)
            .accounts({
                buyer: buyer.publicKey,
                mint,
                offer: offerPda,
                metadata,
                systemProgram: SystemProgram.programId,
            })
            .signers([buyer])
            .rpc();

        await (program.methods as any)
            .cancelOffer()
            .accounts({
                buyer: buyer.publicKey,
                mint,
                offer: offerPda,
            })
            .signers([buyer])
            .rpc();

        // Interact
        try {
            await (program.methods as any)
                .cancelOffer()
                .accounts({
                    buyer: buyer.publicKey,
                    mint,
                    offer: offerPda,
                })
                .signers([buyer])
                .rpc();

            assert.fail("canceling a closed offer should fail");
        } catch (err: any) {
            // Assert
            assert.equal(err?.error?.errorCode?.code, "AccountNotInitialized");
        }
    });

    it("cancel_offer: fails if not buyer", async () => {
        // Setup
        const { seller, buyer, mint, metadata } = await setup();
        const priceLamports = Math.floor(0.2 * LAMPORTS_PER_SOL);
        const price = new anchor.BN(priceLamports);

        const [offerPda] = deriveOfferPda(buyer.publicKey, mint);

        await (program.methods as any)
            .makeOffer(price)
            .accounts({
                buyer: buyer.publicKey,
                mint,
                offer: offerPda,
                metadata,
                systemProgram: SystemProgram.programId,
            })
            .signers([buyer])
            .rpc();

        // Interact
        try {
            await (program.methods as any)
                .cancelOffer()
                .accounts({
                    buyer: seller.publicKey,
                    mint,
                    offer: offerPda,
                })
                .signers([seller])
                .rpc();

            assert.fail("canceling an offer by a non-buyer should fail");
        } catch (err: any) {
            // Assert
            assert.equal(err?.error?.errorCode?.code, "ConstraintSeeds");
        }
    });

    it("cancel_offer: fails if wrong mint is provided", async () => {
        // Setup
        const { buyer, mint, metadata, collectionMint } = await setup();
        const priceLamports = Math.floor(0.2 * LAMPORTS_PER_SOL);
        const price = new anchor.BN(priceLamports);

        const [offerPda] = deriveOfferPda(buyer.publicKey, mint);

        await (program.methods as any)
            .makeOffer(price)
            .accounts({
                buyer: buyer.publicKey,
                mint,
                offer: offerPda,
                metadata,
                systemProgram: SystemProgram.programId,
            })
            .signers([buyer])
            .rpc();

        // Interact
        try {
            await (program.methods as any)
                .cancelOffer()
                .accounts({
                    buyer: buyer.publicKey,
                    mint: collectionMint,
                    offer: offerPda,
                })
                .signers([buyer])
                .rpc();

            assert.fail("canceling an offer with the wrong mint should fail");
        } catch (err: any) {
            // Assert
            assert.equal(err?.error?.errorCode?.code, "ConstraintSeeds");
        }
    });

    // -------------------------------
    // Failure tests: accept_offer()
    // -------------------------------

    it("accept_offer: fails on second accept after offer is closed", async () => {
        // Setup
        const { seller, buyer, mint, sellerAta, buyerAta, metadata } = await setup();
        const priceLamports = Math.floor(0.2 * LAMPORTS_PER_SOL);
        const price = new anchor.BN(priceLamports);

        const [offerPda] = deriveOfferPda(buyer.publicKey, mint);

        await (program.methods as any)
            .makeOffer(price)
            .accounts({
                buyer: buyer.publicKey,
                mint,
                offer: offerPda,
                metadata,
                systemProgram: SystemProgram.programId,
            })
            .signers([buyer])
            .rpc();

        await (program.methods as any)
            .acceptOffer()
            .accounts({
                seller: seller.publicKey,
                buyer: buyer.publicKey,
                mint,
                offer: offerPda,
                sellerNftAta: sellerAta,
                buyerNftAta: buyerAta,
                tokenProgram: TOKEN_PROGRAM_ID,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
            })
            .signers([seller])
            .rpc();

        // Interact
        try {
            await (program.methods as any)
                .acceptOffer()
                .accounts({
                    seller: seller.publicKey,
                    buyer: buyer.publicKey,
                    mint,
                    offer: offerPda,
                    sellerNftAta: sellerAta,
                    buyerNftAta: buyerAta,
                    tokenProgram: TOKEN_PROGRAM_ID,
                    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                    systemProgram: SystemProgram.programId,
                })
                .signers([seller])
                .rpc();

            assert.fail("accepting a closed offer should fail");
        } catch (err: any) {
            // Assert
            assert.equal(err?.error?.errorCode?.code, "AccountNotInitialized");
        }
    });

    it("accept_offer: fails if wrong buyer account is provided", async () => {
        // Setup
        const { seller, buyer, mint, sellerAta, buyerAta, metadata } = await setup();
        const wrongBuyer = Keypair.generate();
        const priceLamports = Math.floor(0.2 * LAMPORTS_PER_SOL);
        const price = new anchor.BN(priceLamports);

        await airdrop(wrongBuyer.publicKey, 1);

        const [offerPda] = deriveOfferPda(buyer.publicKey, mint);

        await (program.methods as any)
            .makeOffer(price)
            .accounts({
                buyer: buyer.publicKey,
                mint,
                offer: offerPda,
                metadata,
                systemProgram: SystemProgram.programId,
            })
            .signers([buyer])
            .rpc();

        // Interact
        try {
            await (program.methods as any)
                .acceptOffer()
                .accounts({
                    seller: seller.publicKey,
                    buyer: wrongBuyer.publicKey,
                    mint,
                    offer: offerPda,
                    sellerNftAta: sellerAta,
                    buyerNftAta: buyerAta,
                    tokenProgram: TOKEN_PROGRAM_ID,
                    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                    systemProgram: SystemProgram.programId,
                })
                .signers([seller])
                .rpc();

            assert.fail("accepting an offer with the wrong buyer account should fail");
        } catch (err: any) {
            // Assert
            assert.equal(err?.error?.errorCode?.code, "ConstraintTokenOwner");
        }
    });

    it("accept_offer: fails if wrong mint is provided", async () => {
        // Setup
        const { seller, buyer, mint, sellerAta, buyerAta, metadata, collectionMint } = await setup();
        const priceLamports = Math.floor(0.2 * LAMPORTS_PER_SOL);
        const price = new anchor.BN(priceLamports);

        const [offerPda] = deriveOfferPda(buyer.publicKey, mint);

        await (program.methods as any)
            .makeOffer(price)
            .accounts({
                buyer: buyer.publicKey,
                mint,
                offer: offerPda,
                metadata,
                systemProgram: SystemProgram.programId,
            })
            .signers([buyer])
            .rpc();

        // Interact
        try {
            await (program.methods as any)
                .acceptOffer()
                .accounts({
                    seller: seller.publicKey,
                    buyer: buyer.publicKey,
                    mint: collectionMint,
                    offer: offerPda,
                    sellerNftAta: sellerAta,
                    buyerNftAta: buyerAta,
                    tokenProgram: TOKEN_PROGRAM_ID,
                    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                    systemProgram: SystemProgram.programId,
                })
                .signers([seller])
                .rpc();

            assert.fail("accepting an offer with the wrong mint should fail");
        } catch (err: any) {
            // Assert
            assert.equal(err?.error?.errorCode?.code, "ConstraintTokenMint");
        }
    });

    it("accept_offer: fails if seller ATA is invalid", async () => {
        // Setup
        const { seller, buyer, mint, buyerAta, metadata } = await setup();
        const priceLamports = Math.floor(0.2 * LAMPORTS_PER_SOL);
        const price = new anchor.BN(priceLamports);

        const [offerPda] = deriveOfferPda(buyer.publicKey, mint);

        await (program.methods as any)
            .makeOffer(price)
            .accounts({
                buyer: buyer.publicKey,
                mint,
                offer: offerPda,
                metadata,
                systemProgram: SystemProgram.programId,
            })
            .signers([buyer])
            .rpc();

        // Interact
        try {
            await (program.methods as any)
                .acceptOffer()
                .accounts({
                    seller: seller.publicKey,
                    buyer: buyer.publicKey,
                    mint,
                    offer: offerPda,
                    sellerNftAta: buyerAta,
                    buyerNftAta: buyerAta,
                    tokenProgram: TOKEN_PROGRAM_ID,
                    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                    systemProgram: SystemProgram.programId,
                })
                .signers([seller])
                .rpc();

            assert.fail("accepting an offer with an invalid seller ATA should fail");
        } catch (err: any) {
            // Assert
            assert.equal(err?.error?.errorCode?.code, "ConstraintTokenOwner");
        }
    });

    it("accept_offer: fails if buyer ATA is invalid", async () => {
        // Setup
        const { seller, buyer, mint, sellerAta, metadata } = await setup();
        const priceLamports = Math.floor(0.2 * LAMPORTS_PER_SOL);
        const price = new anchor.BN(priceLamports);

        const [offerPda] = deriveOfferPda(buyer.publicKey, mint);

        await (program.methods as any)
            .makeOffer(price)
            .accounts({
                buyer: buyer.publicKey,
                mint,
                offer: offerPda,
                metadata,
                systemProgram: SystemProgram.programId,
            })
            .signers([buyer])
            .rpc();

        // Interact
        try {
            await (program.methods as any)
                .acceptOffer()
                .accounts({
                    seller: seller.publicKey,
                    buyer: buyer.publicKey,
                    mint,
                    offer: offerPda,
                    sellerNftAta: sellerAta,
                    buyerNftAta: sellerAta,
                    tokenProgram: TOKEN_PROGRAM_ID,
                    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                    systemProgram: SystemProgram.programId,
                })
                .signers([seller])
                .rpc();

            assert.fail("accepting an offer with an invalid buyer ATA should fail");
        } catch (err: any) {
            // Assert
            assert.equal(err?.error?.errorCode?.code, "ConstraintTokenOwner");
        }
    });

    it("accept_offer: fails if seller tries to accept their own offer", async () => {
        // Setup
        const { seller, mint, sellerAta, metadata } = await setup();
        const priceLamports = Math.floor(0.2 * LAMPORTS_PER_SOL);
        const price = new anchor.BN(priceLamports);

        const [offerPda] = deriveOfferPda(seller.publicKey, mint);

        await (program.methods as any)
            .makeOffer(price)
            .accounts({
                buyer: seller.publicKey,
                mint,
                offer: offerPda,
                metadata,
                systemProgram: SystemProgram.programId,
            })
            .signers([seller])
            .rpc();

        // Interact
        try {
            await (program.methods as any)
                .acceptOffer()
                .accounts({
                    seller: seller.publicKey,
                    buyer: seller.publicKey,
                    mint,
                    offer: offerPda,
                    sellerNftAta: sellerAta,
                    buyerNftAta: sellerAta,
                    tokenProgram: TOKEN_PROGRAM_ID,
                    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                    systemProgram: SystemProgram.programId,
                })
                .signers([seller])
                .rpc();

            assert.fail("self-accepting should fail");
        } catch (err: any) {
            // Assert
            assert.equal(err?.error?.errorCode?.code, "AcceptOwnOfferNotAllowed");
        }
    });

    it("accept_offer: fails when seller ATA has no NFT", async () => {
        // Setup
        const { buyer, mint, buyerAta, metadata } = await setup();
        const fakeSeller = Keypair.generate();
        const priceLamports = Math.floor(0.2 * LAMPORTS_PER_SOL);
        const price = new anchor.BN(priceLamports);

        await airdrop(fakeSeller.publicKey, 1);

        const fakeSellerAta = await getOrCreateAssociatedTokenAccount(
            connection,
            fakeSeller,
            mint,
            fakeSeller.publicKey,
        );

        const [offerPda] = deriveOfferPda(buyer.publicKey, mint);

        await (program.methods as any)
            .makeOffer(price)
            .accounts({
                buyer: buyer.publicKey,
                mint,
                offer: offerPda,
                metadata,
                systemProgram: SystemProgram.programId,
            })
            .signers([buyer])
            .rpc();

        // Interact
        try {
            await (program.methods as any)
                .acceptOffer()
                .accounts({
                    seller: fakeSeller.publicKey,
                    buyer: buyer.publicKey,
                    mint,
                    offer: offerPda,
                    sellerNftAta: fakeSellerAta.address,
                    buyerNftAta: buyerAta,
                    tokenProgram: TOKEN_PROGRAM_ID,
                    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                    systemProgram: SystemProgram.programId,
                })
                .signers([fakeSeller])
                .rpc();

            assert.fail("accepting an offer without owning the NFT should fail");
        } catch (err: any) {
            // Assert
            assert.equal(err?.error?.errorCode?.code, "InvalidNftAmount");
        }
    });
});
