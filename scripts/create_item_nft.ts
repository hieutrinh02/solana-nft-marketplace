import "dotenv/config";

import { readFileSync } from "node:fs";

import {
    createNft,
    findMasterEditionPda,
    findMetadataPda,
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
import { Connection, Keypair, PublicKey } from "@solana/web3.js";

const DEFAULT_NAME = "Marketplace NFT 03";
const DEFAULT_SYMBOL = "MNFT";
const DEFAULT_URI =
    "https://raw.githubusercontent.com/hieutrinh02/solana-nft-marketplace-program/main/assets/nft/item_03.json";
const COLLECTION_MINT = "8AMGnDMKQiWEvEf84AQe3EJnNbragwTL6bQ36XupzdcJ";

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

    const collectionMint = new PublicKey(COLLECTION_MINT);
    const mintSigner = generateSigner(umi);

    await createNft(umi, {
        mint: mintSigner,
        name: DEFAULT_NAME,
        symbol: DEFAULT_SYMBOL,
        uri: DEFAULT_URI,
        sellerFeeBasisPoints: percentAmount(0),
        collection: {
            key: publicKey(collectionMint),
            verified: false,
        },
    }).sendAndConfirm(umi);

    const itemMint = new PublicKey(mintSigner.publicKey);
    const [itemMetadata] = findMetadataPda(umi, { mint: publicKey(itemMint) });
    const [itemMasterEdition] = findMasterEditionPda(umi, { mint: publicKey(itemMint) });

    await verifyCollectionV1(umi, {
        metadata: itemMetadata,
        authority: umi.identity,
        collectionMint: publicKey(collectionMint),
    }).sendAndConfirm(umi);

    console.log(`RPC URL: ${rpcUrl}`);
    console.log(`Authority: ${authority.publicKey.toBase58()}`);
    console.log(`Collection: ${collectionMint.toBase58()}`);
    console.log(`Name: ${DEFAULT_NAME}`);
    console.log(`Symbol: ${DEFAULT_SYMBOL}`);
    console.log(`URI: ${DEFAULT_URI}`);
    console.log(`Mint: ${itemMint.toBase58()}`);
    console.log(`Metadata: ${itemMetadata}`);
    console.log(`Master Edition: ${itemMasterEdition}`);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
