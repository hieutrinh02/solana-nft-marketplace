import "dotenv/config";

import { readFileSync } from "node:fs";

import {
    createNft,
    findMasterEditionPda,
    findMetadataPda,
    mplTokenMetadata,
} from "@metaplex-foundation/mpl-token-metadata";
import {
    generateSigner,
    keypairIdentity,
    percentAmount,
    publicKey,
} from "@metaplex-foundation/umi";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";

const DEFAULT_NAME = "Marketplace Collection";
const DEFAULT_SYMBOL = "MCOL";
const DEFAULT_URI =
    "https://raw.githubusercontent.com/hieutrinh02/solana-nft-marketplace-program/main/assets/nft/collection.json";

function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Missing required env var: ${name}`);
    }
    return value;
}

function getKeypair(): Keypair {
    const keypairPath = requireEnv("ADMIN_KEYPAIR_PATH");
    const secret = JSON.parse(readFileSync(keypairPath, "utf8")) as number[];
    return Keypair.fromSecretKey(Uint8Array.from(secret));
}

async function main() {
    const rpcUrl = requireEnv("RPC_URL");
    const authority = getKeypair();
    const connection = new Connection(rpcUrl, "confirmed");
    const umi = createUmi(connection).use(mplTokenMetadata());
    const umiKeypair = umi.eddsa.createKeypairFromSecretKey(authority.secretKey);
    umi.use(keypairIdentity(umiKeypair, true));

    const mintSigner = generateSigner(umi);

    await createNft(umi, {
        mint: mintSigner,
        name: DEFAULT_NAME,
        symbol: DEFAULT_SYMBOL,
        uri: DEFAULT_URI,
        sellerFeeBasisPoints: percentAmount(0),
        isCollection: true,
    }).sendAndConfirm(umi);

    const mint = new PublicKey(mintSigner.publicKey);
    const [metadata] = findMetadataPda(umi, { mint: publicKey(mint) });
    const [masterEdition] = findMasterEditionPda(umi, { mint: publicKey(mint) });

    console.log(`RPC URL: ${rpcUrl}`);
    console.log(`Authority: ${authority.publicKey.toBase58()}`);
    console.log(`Name: ${DEFAULT_NAME}`);
    console.log(`Symbol: ${DEFAULT_SYMBOL}`);
    console.log(`URI: ${DEFAULT_URI}`);
    console.log(`Mint: ${mint.toBase58()}`);
    console.log(`Metadata: ${metadata}`);
    console.log(`Master Edition: ${masterEdition}`);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
