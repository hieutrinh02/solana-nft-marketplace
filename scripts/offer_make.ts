import "dotenv/config";

import { readFileSync } from "node:fs";

import * as anchor from "@coral-xyz/anchor";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";

const NFT_MINT = "B1DNsEcuKBdv4V5hHyC61gYfkJd1BuNhEzaK4Ym21kGs";
const PRICE_SOL = 0.2;
const TOKEN_METADATA_PROGRAM_ID = new PublicKey(
    "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s",
);
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
    const buyer = getKeypair("BUYER_KEYPAIR_PATH");
    const connection = new anchor.web3.Connection(rpcUrl, "confirmed");
    const wallet = new anchor.Wallet(buyer);
    const provider = new anchor.AnchorProvider(connection, wallet, {
        commitment: "confirmed",
    });
    const programIdl = { ...idl, address: programId.toBase58() };
    const program = new anchor.Program(programIdl, provider) as any;

    const mint = new PublicKey(NFT_MINT);
    const priceLamports = Math.floor(PRICE_SOL * anchor.web3.LAMPORTS_PER_SOL);
    const price = new anchor.BN(priceLamports);

    const [offerPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("offer"), buyer.publicKey.toBuffer(), mint.toBuffer()],
        programId,
    );
    const [metadata] = PublicKey.findProgramAddressSync(
        [
            Buffer.from("metadata"),
            TOKEN_METADATA_PROGRAM_ID.toBuffer(),
            mint.toBuffer(),
        ],
        TOKEN_METADATA_PROGRAM_ID,
    );

    const signature = await program.methods
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

    console.log(`RPC URL: ${rpcUrl}`);
    console.log(`Program ID: ${programId.toBase58()}`);
    console.log(`Buyer: ${buyer.publicKey.toBase58()}`);
    console.log(`Mint: ${mint.toBase58()}`);
    console.log(`Price (SOL): ${PRICE_SOL}`);
    console.log(`Price (lamports): ${priceLamports}`);
    console.log(`Metadata: ${metadata.toBase58()}`);
    console.log(`Offer PDA: ${offerPda.toBase58()}`);
    console.log(`Signature: ${signature}`);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
