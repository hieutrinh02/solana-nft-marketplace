import "dotenv/config";

import { readFileSync } from "node:fs";

import * as anchor from "@coral-xyz/anchor";
import {
    ASSOCIATED_TOKEN_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    getAssociatedTokenAddress,
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";

const NFT_MINT = "B1DNsEcuKBdv4V5hHyC61gYfkJd1BuNhEzaK4Ym21kGs";
const BUYER = "BNToqmqXLNvUrEGGS7io3MQodB9dT56M4Q1Q8xcPYyk7";
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

function getKeypair(pathEnv: string): Keypair {
    const keypairPath = requireEnv(pathEnv);
    const secret = JSON.parse(readFileSync(keypairPath, "utf8")) as number[];
    return Keypair.fromSecretKey(Uint8Array.from(secret));
}

async function main() {
    const rpcUrl = requireEnv("RPC_URL");
    const programId = new PublicKey(requireEnv("PROGRAM_ID"));
    const seller = getKeypair("SELLER_KEYPAIR_PATH");
    const connection = new anchor.web3.Connection(rpcUrl, "confirmed");
    const wallet = new anchor.Wallet(seller);
    const provider = new anchor.AnchorProvider(connection, wallet, {
        commitment: "confirmed",
    });
    const programIdl = { ...idl, address: programId.toBase58() };
    const program = new anchor.Program(programIdl, provider) as any;

    const mint = new PublicKey(NFT_MINT);
    const buyer = new PublicKey(BUYER);

    const [offerPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("offer"), buyer.toBuffer(), mint.toBuffer()],
        programId,
    );
    const sellerNftAta = await getAssociatedTokenAddress(
        mint,
        seller.publicKey,
        false,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
    );
    const buyerNftAta = await getAssociatedTokenAddress(
        mint,
        buyer,
        false,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
    );

    const signature = await program.methods
        .acceptOffer()
        .accounts({
            seller: seller.publicKey,
            buyer,
            mint,
            offer: offerPda,
            sellerNftAta,
            buyerNftAta,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
        })
        .signers([seller])
        .rpc();

    console.log(`RPC URL: ${rpcUrl}`);
    console.log(`Program ID: ${programId.toBase58()}`);
    console.log(`Seller: ${seller.publicKey.toBase58()}`);
    console.log(`Buyer: ${buyer.toBase58()}`);
    console.log(`Mint: ${mint.toBase58()}`);
    console.log(`Offer PDA: ${offerPda.toBase58()}`);
    console.log(`Seller ATA: ${sellerNftAta.toBase58()}`);
    console.log(`Buyer ATA: ${buyerNftAta.toBase58()}`);
    console.log(`Signature: ${signature}`);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
