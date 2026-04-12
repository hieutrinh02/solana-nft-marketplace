import "dotenv/config";

import { readFileSync } from "node:fs";

import * as anchor from "@coral-xyz/anchor";
import {
    ASSOCIATED_TOKEN_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    getAssociatedTokenAddress,
} from "@solana/spl-token";
import { Keypair, PublicKey } from "@solana/web3.js";

const NFT_MINT = "B1DNsEcuKBdv4V5hHyC61gYfkJd1BuNhEzaK4Ym21kGs";
const idl = JSON.parse(
    readFileSync("target/idl/solana_nft_marketplace_program.json", "utf8"),
);

function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Missing required env var: ${name}`);
    }
    return value;
}

function getKeypair(): Keypair {
    const keypairPath = requireEnv("SELLER_KEYPAIR_PATH");
    const secret = JSON.parse(readFileSync(keypairPath, "utf8")) as number[];
    return Keypair.fromSecretKey(Uint8Array.from(secret));
}

async function main() {
    const rpcUrl = requireEnv("RPC_URL");
    const programId = new PublicKey(requireEnv("PROGRAM_ID"));
    const seller = getKeypair();
    const connection = new anchor.web3.Connection(rpcUrl, "confirmed");
    const wallet = new anchor.Wallet(seller);
    const provider = new anchor.AnchorProvider(connection, wallet, {
        commitment: "confirmed",
    });
    const programIdl = { ...idl, address: programId.toBase58() };
    const program = new anchor.Program(programIdl, provider) as any;

    const mint = new PublicKey(NFT_MINT);

    const [listingPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("listing"), mint.toBuffer()],
        programId,
    );
    const sellerNftAta = await getAssociatedTokenAddress(
        mint,
        seller.publicKey,
        false,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
    );
    const escrowNftAta = await getAssociatedTokenAddress(
        mint,
        listingPda,
        true,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
    );

    const signature = await program.methods
        .cancel()
        .accounts({
            seller: seller.publicKey,
            mint,
            listing: listingPda,
            sellerNftAta,
            escrowNftAta,
            tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([seller])
        .rpc();

    console.log(`RPC URL: ${rpcUrl}`);
    console.log(`Program ID: ${programId.toBase58()}`);
    console.log(`Seller: ${seller.publicKey.toBase58()}`);
    console.log(`Mint: ${mint.toBase58()}`);
    console.log(`Listing PDA: ${listingPda.toBase58()}`);
    console.log(`Seller ATA: ${sellerNftAta.toBase58()}`);
    console.log(`Escrow ATA: ${escrowNftAta.toBase58()}`);
    console.log(`Signature: ${signature}`);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
