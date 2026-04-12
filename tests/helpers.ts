import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
    MPL_TOKEN_METADATA_PROGRAM_ID,
    createNft,
    mplTokenMetadata,
    verifyCollectionV1,
} from "@metaplex-foundation/mpl-token-metadata";
import {
    generateSigner,
    keypairIdentity,
    percentAmount,
    publicKey,
} from "@metaplex-foundation/umi";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import {
    ASSOCIATED_TOKEN_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    getAssociatedTokenAddress,
    getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";
import { Keypair, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { SolanaNftMarketplaceProgram } from "../target/types/solana_nft_marketplace_program";

export const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);

export const program = anchor.workspace
    .solanaNftMarketplaceProgram as Program<SolanaNftMarketplaceProgram>;

export const connection = provider.connection;
export const TOKEN_METADATA_PROGRAM_ID = new PublicKey(
    MPL_TOKEN_METADATA_PROGRAM_ID,
);

// Listing PDA = ["listing", mint]
export function deriveListingPda(mint: PublicKey) {
    return PublicKey.findProgramAddressSync(
        [Buffer.from("listing"), mint.toBuffer()],
        program.programId,
    );
}

// Escrow ATA = ATA(mint, owner = listing PDA)
export async function deriveEscrowAta(mint: PublicKey, listingPda: PublicKey) {
    return getAssociatedTokenAddress(
        mint,
        listingPda,
        true,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
    );
}

// Offer PDA = ["offer", buyer, mint]
export function deriveOfferPda(buyer: PublicKey, mint: PublicKey) {
    return PublicKey.findProgramAddressSync(
        [Buffer.from("offer"), buyer.toBuffer(), mint.toBuffer()],
        program.programId,
    );
}

// Metadata PDA = ["metadata", TOKEN_METADATA_PROGRAM_ID, mint]
export function deriveMetadataPda(mint: PublicKey) {
    return PublicKey.findProgramAddressSync(
        [
            Buffer.from("metadata"),
            TOKEN_METADATA_PROGRAM_ID.toBuffer(),
            mint.toBuffer(),
        ],
        TOKEN_METADATA_PROGRAM_ID,
    );
}

export async function airdrop(pubkey: PublicKey, sol = 2) {
    const sig = await connection.requestAirdrop(pubkey, sol * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig, "confirmed");
}

export async function setup() {
    // Test actors: seller starts with the NFT, buyer is used for later buy/offer flows.
    const seller = Keypair.generate();
    const buyer = Keypair.generate();

    await airdrop(seller.publicKey, 2);
    await airdrop(buyer.publicKey, 2);

    // Umi drives the Metaplex-side asset creation and collection verification.
    const umi = createUmi(connection).use(mplTokenMetadata());
    const umiKeypair = umi.eddsa.createKeypairFromSecretKey(seller.secretKey);
    umi.use(keypairIdentity(umiKeypair, true));

    // Separate collection NFT used only as the verified collection parent.
    const collectionMintSigner = generateSigner(umi);
    await createNft(umi, {
        mint: collectionMintSigner,
        name: "Marketplace Collection",
        symbol: "MCOL",
        uri: "https://raw.githubusercontent.com/hieutrinh02/solana-nft-marketplace-program/main/assets/nft/collection.json",
        sellerFeeBasisPoints: percentAmount(0),
        isCollection: true,
    }).sendAndConfirm(umi);

    const collectionMint = new PublicKey(collectionMintSigner.publicKey);

    // Regular NFT that the marketplace will trade.
    const nftMintSigner = generateSigner(umi);
    await createNft(umi, {
        mint: nftMintSigner,
        name: "Marketplace NFT",
        symbol: "MNFT",
        uri: "https://raw.githubusercontent.com/hieutrinh02/solana-nft-marketplace-program/main/assets/nft/item_01.json",
        sellerFeeBasisPoints: percentAmount(0),
        collection: {
            key: publicKey(collectionMint),
            verified: false,
        },
    }).sendAndConfirm(umi);

    const mint = new PublicKey(nftMintSigner.publicKey);

    // The seller ATA already exists after minting the NFT; derive it directly.
    const sellerAta = await getAssociatedTokenAddress(
        mint,
        seller.publicKey,
        false,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
    );
    const buyerAtaAccount = await getOrCreateAssociatedTokenAccount(
        connection,
        buyer,
        mint,
        buyer.publicKey,
    );

    // Metadata PDA is deterministic from the mint addresses.
    const [metadata] = deriveMetadataPda(mint);
    // Verify the pre-set collection relationship on the regular NFT.
    await verifyCollectionV1(umi, {
        metadata: publicKey(metadata),
        authority: umi.identity,
        collectionMint: publicKey(collectionMint),
    }).sendAndConfirm(umi);

    return {
        seller,
        buyer,
        mint,
        sellerAta,
        buyerAta: buyerAtaAccount.address,
        metadata,
        collectionMint,
    };
}
