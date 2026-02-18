import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  AuthorityType,
  createMint,
  getAccount,
  getAssociatedTokenAddress,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  setAuthority,
} from "@solana/spl-token";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { assert } from "chai";
import { SolanaNftMarketplace } from "../target/types/solana_nft_marketplace";

describe("solana_nft_marketplace", () => {
  // Provider / Program
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace
    .solanaNftMarketplace as Program<SolanaNftMarketplace>;

  const connection = provider.connection;

  // -------------------------------
  // Helpers
  // -------------------------------

  // Listing PDA = ["listing", mint]
  function deriveListingPda(mint: PublicKey) {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("listing"), mint.toBuffer()],
      program.programId,
    );
  }

  // Escrow ATA = ATA(mint, owner = listing PDA)
  async function deriveEscrowAta(mint: PublicKey, listingPda: PublicKey) {
    return getAssociatedTokenAddress(
      mint,
      listingPda,
      true, // allowOwnerOffCurve because owner is PDA
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
  }

  async function airdrop(pubkey: PublicKey, sol = 2) {
    const sig = await connection.requestAirdrop(pubkey, sol * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig, "confirmed");
  }

  /**
   * Create a fresh NFT mint + fresh seller/buyer keypairs + ATAs.
   *
   * Important: your on-chain `list()` requires:
   * - mint.decimals == 0
   * - mint.supply == 1
   * - mint_authority == None
   * - freeze_authority == None
   * - seller_nft_ata.amount == 1
   *
   * To satisfy this in tests:
   * 1) Create mint with temporary mint authority (seller)
   * 2) Mint exactly 1 token to seller ATA
   * 3) Revoke mint authority (set to None)
   * 4) Ensure freeze authority is None
   */
  async function setupFreshNft(opts?: {
    mintToSeller?: boolean; // mint 1 token to seller ATA
    decimals?: number; // mint decimals
    supplyToMint?: number; // how many tokens to mint to seller (default 1)
    keepMintAuthority?: boolean; // keep mint authority non-null (for failure test)
    freezeAuthority?: "none" | "seller"; // set freeze authority at creation time (for failure test)
    buyerIsSeller?: boolean; // for self-buy test (buyer == seller)
  }) {
    const {
      mintToSeller = true,
      decimals = 0,
      supplyToMint = 1,
      keepMintAuthority = false,
      freezeAuthority = "none",
      buyerIsSeller = false,
    } = opts ?? {};

    const seller = Keypair.generate();
    const buyer = buyerIsSeller ? seller : Keypair.generate();

    await airdrop(seller.publicKey, 2);
    if (!buyerIsSeller) await airdrop(buyer.publicKey, 2);

    // Create mint:
    // - mint authority initially = seller (so we can mint)
    // - freeze authority optionally = seller (to test InvalidFreezeAuthority), otherwise null
    const mint = await createMint(
      connection,
      seller, // payer
      seller.publicKey, // mint authority (temporary)
      freezeAuthority === "seller" ? seller.publicKey : null, // freeze authority
      decimals,
    );

    // Create/get ATAs
    const sellerAtaAcc = await getOrCreateAssociatedTokenAccount(
      connection,
      seller,
      mint,
      seller.publicKey,
    );

    const buyerAtaAcc = await getOrCreateAssociatedTokenAccount(
      connection,
      buyer,
      mint,
      buyer.publicKey,
    );

    if (mintToSeller) {
      // Mint supplyToMint to seller ATA
      const sig = await mintTo(
        connection,
        seller, // payer
        mint,
        sellerAtaAcc.address,
        seller.publicKey, // mint authority
        supplyToMint,
      );
      await connection.confirmTransaction(sig, "confirmed");
    }

    // Revoke authorities to match on-chain checks (unless keepMintAuthority requested)
    if (!keepMintAuthority) {
      await setAuthority(
        connection,
        seller, // payer
        mint,
        seller.publicKey, // current mint authority
        AuthorityType.MintTokens,
        null, // new mint authority = None
      );
    }

    return {
      seller,
      buyer,
      mint,
      sellerAta: sellerAtaAcc.address,
      buyerAta: buyerAtaAcc.address,
    };
  }

  // -------------------------------
  // Happy paths
  // -------------------------------

  it("list: moves NFT to escrow and creates listing", async () => {
    const { seller, mint, sellerAta } = await setupFreshNft();
    const priceLamports = Math.floor(0.2 * LAMPORTS_PER_SOL);
    const price = new anchor.BN(priceLamports);

    const [listingPda, bump] = deriveListingPda(mint);
    const escrow = await deriveEscrowAta(mint, listingPda);

    await program.methods
      .list(price)
      .accounts({
        seller: seller.publicKey,
        mint,
        listing: listingPda,
        sellerNftAta: sellerAta,
        escrowNftAta: escrow,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([seller])
      .rpc();

    const sellerToken = await getAccount(connection, sellerAta);
    assert.equal(sellerToken.amount.toString(), "0");

    const escrowToken = await getAccount(connection, escrow);
    assert.equal(escrowToken.amount.toString(), "1");

    const listing = await program.account.listing.fetch(listingPda);
    assert.equal(listing.seller.toString(), seller.publicKey.toString());
    assert.equal(listing.mint.toString(), mint.toString());
    assert.equal(listing.price.toString(), price.toString());
    assert.equal(listing.bump, bump);
  });

  it("cancel: returns NFT and closes escrow and listing", async () => {
    const { seller, mint, sellerAta } = await setupFreshNft();
    const priceLamports = Math.floor(0.2 * LAMPORTS_PER_SOL);
    const price = new anchor.BN(priceLamports);

    const [listingPda] = deriveListingPda(mint);
    const escrow = await deriveEscrowAta(mint, listingPda);

    await program.methods
      .list(price)
      .accounts({
        seller: seller.publicKey,
        mint,
        listing: listingPda,
        sellerNftAta: sellerAta,
        escrowNftAta: escrow,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([seller])
      .rpc();

    await program.methods
      .cancel()
      .accounts({
        seller: seller.publicKey,
        mint,
        listing: listingPda,
        sellerNftAta: sellerAta,
        escrowNftAta: escrow,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([seller])
      .rpc();

    const sellerToken = await getAccount(connection, sellerAta);
    assert.equal(sellerToken.amount.toString(), "1");

    // Escrow ATA should be closed
    try {
      await getAccount(connection, escrow);
      assert.fail("Escrow ATA should be closed");
    } catch (_) {
      // expected
    }

    // Listing should be closed
    try {
      await program.account.listing.fetch(listingPda);
      assert.fail("Listing account should be closed");
    } catch (_) {
      // expected
    }
  });

  it("buy: transfers SOL and NFT and closes escrow and listing", async () => {
    const { seller, buyer, mint, sellerAta, buyerAta } = await setupFreshNft();
    const priceLamports = Math.floor(0.2 * LAMPORTS_PER_SOL);
    const price = new anchor.BN(priceLamports);

    const [listingPda] = deriveListingPda(mint);
    const escrow = await deriveEscrowAta(mint, listingPda);

    await program.methods
      .list(price)
      .accounts({
        seller: seller.publicKey,
        mint,
        listing: listingPda,
        sellerNftAta: sellerAta,
        escrowNftAta: escrow,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([seller])
      .rpc();

    const sellerLamportsBefore = await connection.getBalance(seller.publicKey);
    const buyerLamportsBefore = await connection.getBalance(buyer.publicKey);

    await program.methods
      .buy()
      .accounts({
        buyer: buyer.publicKey,
        seller: seller.publicKey,
        mint,
        listing: listingPda,
        escrowNftAta: escrow,
        buyerNftAta: buyerAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([buyer])
      .rpc();

    // Buyer owns NFT
    const buyerToken = await getAccount(connection, buyerAta);
    assert.equal(buyerToken.amount.toString(), "1");

    // Escrow ATA should be closed
    try {
      await getAccount(connection, escrow);
      assert.fail("Escrow ATA should be closed");
    } catch (_) {
      // expected
    }

    // Listing should be closed
    try {
      await program.account.listing.fetch(listingPda);
      assert.fail("Listing account should be closed");
    } catch (_) {
      // expected
    }

    // Seller received SOL (at least price)
    const sellerLamportsAfter = await connection.getBalance(seller.publicKey);
    assert.isAtLeast(sellerLamportsAfter - sellerLamportsBefore, priceLamports);

    // Buyer paid SOL (+ fee)
    const buyerLamportsAfter = await connection.getBalance(buyer.publicKey);
    assert.isAtLeast(buyerLamportsBefore - buyerLamportsAfter, priceLamports);
  });

  // -------------------------------
  // Failure tests: list()
  // -------------------------------

  it("list: fails if listing PDA already exists for same mint", async () => {
    const { seller, mint, sellerAta } = await setupFreshNft();
    const priceLamports = Math.floor(0.2 * LAMPORTS_PER_SOL);
    const price = new anchor.BN(priceLamports);

    const [listingPda] = deriveListingPda(mint);
    const escrow = await deriveEscrowAta(mint, listingPda);

    await program.methods
      .list(price)
      .accounts({
        seller: seller.publicKey,
        mint,
        listing: listingPda,
        sellerNftAta: sellerAta,
        escrowNftAta: escrow,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([seller])
      .rpc();

    // Try listing again with the same mint (same PDA)
    try {
      await program.methods
        .list(price)
        .accounts({
          seller: seller.publicKey,
          mint,
          listing: listingPda,
          sellerNftAta: sellerAta,
          escrowNftAta: escrow,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([seller])
        .rpc();

      assert.fail("Should have failed");
    } catch (err: any) {
      assert.include(
        err.toString().toLowerCase(),
        "already in use",
        "Expected invalid price error not received",
      );
    }
  });

  it("list: fails if seller's ATA is invalid", async () => {
    const { seller, mint, sellerAta } = await setupFreshNft();
    const priceLamports = Math.floor(0.2 * LAMPORTS_PER_SOL);
    const price = new anchor.BN(priceLamports);

    const [listingPda] = deriveListingPda(mint);
    const escrow = await deriveEscrowAta(mint, listingPda);

    // attacker
    const attacker = Keypair.generate();
    await airdrop(attacker.publicKey, 1);
    const attackerAtaAcc = await getOrCreateAssociatedTokenAccount(
      connection,
      attacker,
      mint,
      attacker.publicKey,
    );

    try {
      await program.methods
        .list(price)
        .accounts({
          seller: seller.publicKey,
          mint,
          listing: listingPda,
          sellerNftAta: attackerAtaAcc.address,
          escrowNftAta: escrow,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([seller])
        .rpc();

      assert.fail("Should have failed");
    } catch (err: any) {
      const code = err?.error?.errorCode?.code;
      assert.equal(code, "ConstraintTokenOwner", "Expected error not received");
    }
  });

  it("list: fails if escrow ATA is invalid", async () => {
    const { seller, mint, sellerAta, buyerAta } = await setupFreshNft();
    const priceLamports = Math.floor(0.2 * LAMPORTS_PER_SOL);
    const price = new anchor.BN(priceLamports);

    const [listingPda] = deriveListingPda(mint);

    const fakeEscrow = buyerAta;

    try {
      await program.methods
        .list(price)
        .accounts({
          seller: seller.publicKey,
          mint,
          listing: listingPda,
          sellerNftAta: sellerAta,
          escrowNftAta: fakeEscrow,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([seller])
        .rpc();

      assert.fail("Should have failed");
    } catch (err: any) {
      const code = err?.error?.errorCode?.code;
      assert.equal(code, "ConstraintTokenOwner", "Expected error not received");
    }
  });

  it("list: fails when price is 0", async () => {
    const { seller, mint, sellerAta } = await setupFreshNft();
    const [listingPda] = deriveListingPda(mint);
    const escrow = await deriveEscrowAta(mint, listingPda);

    try {
      await program.methods
        .list(new anchor.BN(0))
        .accounts({
          seller: seller.publicKey,
          mint,
          listing: listingPda,
          sellerNftAta: sellerAta,
          escrowNftAta: escrow,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([seller])
        .rpc();

      assert.fail("Should have failed");
    } catch (err: any) {
      assert.include(
        err.toString(),
        "InvalidPrice",
        "Expected invalid price error not received",
      );
    }
  });

  it("list: fails when mint decimals != 0", async () => {
    const { seller, mint, sellerAta } = await setupFreshNft({ decimals: 1 });
    const priceLamports = Math.floor(0.2 * LAMPORTS_PER_SOL);
    const price = new anchor.BN(priceLamports);

    const [listingPda] = deriveListingPda(mint);
    const escrow = await deriveEscrowAta(mint, listingPda);

    try {
      await program.methods
        .list(price)
        .accounts({
          seller: seller.publicKey,
          mint,
          listing: listingPda,
          sellerNftAta: sellerAta,
          escrowNftAta: escrow,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([seller])
        .rpc();

      assert.fail("Should have failed");
    } catch (err: any) {
      assert.include(
        err.toString(),
        "InvalidMintDecimals",
        "Expected invalid mint decimals error not received",
      );
    }
  });

  it("list: fails when mint supply != 1", async () => {
    const { seller, mint, sellerAta } = await setupFreshNft({
      supplyToMint: 2,
    });
    const priceLamports = Math.floor(0.2 * LAMPORTS_PER_SOL);
    const price = new anchor.BN(priceLamports);

    const [listingPda] = deriveListingPda(mint);
    const escrow = await deriveEscrowAta(mint, listingPda);

    try {
      await program.methods
        .list(price)
        .accounts({
          seller: seller.publicKey,
          mint,
          listing: listingPda,
          sellerNftAta: sellerAta,
          escrowNftAta: escrow,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([seller])
        .rpc();

      assert.fail("Should have failed");
    } catch (err: any) {
      assert.include(
        err.toString(),
        "InvalidMintSupply",
        "Expected invalid mint supply error not received",
      );
    }
  });

  it("list: fails when mint authority is not none", async () => {
    const { seller, mint, sellerAta } = await setupFreshNft({
      keepMintAuthority: true,
    });
    const priceLamports = Math.floor(0.2 * LAMPORTS_PER_SOL);
    const price = new anchor.BN(priceLamports);

    const [listingPda] = deriveListingPda(mint);
    const escrow = await deriveEscrowAta(mint, listingPda);

    try {
      await program.methods
        .list(price)
        .accounts({
          seller: seller.publicKey,
          mint,
          listing: listingPda,
          sellerNftAta: sellerAta,
          escrowNftAta: escrow,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([seller])
        .rpc();
      assert.fail("Should have failed");
    } catch (err: any) {
      assert.include(
        err.toString(),
        "InvalidMintAuthority",
        "Expected invalid mint authority error not received",
      );
    }
  });

  it("list: fails when freeze authority is not none", async () => {
    const { seller, mint, sellerAta } = await setupFreshNft({
      freezeAuthority: "seller",
    });
    const priceLamports = Math.floor(0.2 * LAMPORTS_PER_SOL);
    const price = new anchor.BN(priceLamports);

    const [listingPda] = deriveListingPda(mint);
    const escrow = await deriveEscrowAta(mint, listingPda);

    try {
      await program.methods
        .list(price)
        .accounts({
          seller: seller.publicKey,
          mint,
          listing: listingPda,
          sellerNftAta: sellerAta,
          escrowNftAta: escrow,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([seller])
        .rpc();
      assert.fail("Should have failed");
    } catch (err: any) {
      assert.include(
        err.toString(),
        "InvalidFreezeAuthority",
        "Expected invalid freeze authority error not received",
      );
    }
  });

  it("list: fails when seller's ATA has no NFT", async () => {
    const { buyer, mint, buyerAta } = await setupFreshNft();
    const priceLamports = Math.floor(0.2 * LAMPORTS_PER_SOL);
    const price = new anchor.BN(priceLamports);

    const [listingPda] = deriveListingPda(mint);
    const escrow = await deriveEscrowAta(mint, listingPda);

    // Try listing without minting new NFT
    // We use buyer to list because he has no NFT
    try {
      await program.methods
        .list(price)
        .accounts({
          seller: buyer.publicKey,
          mint,
          listing: listingPda,
          sellerNftAta: buyerAta,
          escrowNftAta: escrow,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([buyer])
        .rpc();

      assert.fail("Should have failed");
    } catch (err: any) {
      assert.include(
        err.toString(),
        "InvalidNftAmount",
        "Expected invalid nft amount error not received",
      );
    }
  });

  // -------------------------------
  // Failure tests: cancel()
  // -------------------------------

  it("cancel: fails if not seller", async () => {
    const { seller, mint, sellerAta } = await setupFreshNft();
    const priceLamports = Math.floor(0.2 * LAMPORTS_PER_SOL);
    const price = new anchor.BN(priceLamports);

    const [listingPda] = deriveListingPda(mint);
    const escrow = await deriveEscrowAta(mint, listingPda);

    await program.methods
      .list(price)
      .accounts({
        seller: seller.publicKey,
        mint,
        listing: listingPda,
        sellerNftAta: sellerAta,
        escrowNftAta: escrow,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([seller])
      .rpc();

    // attacker tries cancel
    const attacker = Keypair.generate();
    await airdrop(attacker.publicKey, 1);
    const attackerAtaAcc = await getOrCreateAssociatedTokenAccount(
      connection,
      attacker,
      mint,
      attacker.publicKey,
    );

    try {
      await program.methods
        .cancel()
        .accounts({
          seller: attacker.publicKey, // wrong seller
          mint,
          listing: listingPda,
          sellerNftAta: attackerAtaAcc.address,
          escrowNftAta: escrow,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([attacker])
        .rpc();

      assert.fail("Should have failed");
    } catch (err: any) {
      const code = err?.error?.errorCode?.code;
      assert.equal(code, "ConstraintHasOne", "Expected error not received");
    }
  });

  it("cancel: fails if seller's ATA is invalid", async () => {
    const { seller, mint, sellerAta } = await setupFreshNft();
    const priceLamports = Math.floor(0.2 * LAMPORTS_PER_SOL);
    const price = new anchor.BN(priceLamports);

    const [listingPda] = deriveListingPda(mint);
    const escrow = await deriveEscrowAta(mint, listingPda);

    await program.methods
      .list(price)
      .accounts({
        seller: seller.publicKey,
        mint,
        listing: listingPda,
        sellerNftAta: sellerAta,
        escrowNftAta: escrow,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([seller])
      .rpc();

    // attacker
    const attacker = Keypair.generate();
    await airdrop(attacker.publicKey, 1);
    const attackerAtaAcc = await getOrCreateAssociatedTokenAccount(
      connection,
      attacker,
      mint,
      attacker.publicKey,
    );

    try {
      await program.methods
        .cancel()
        .accounts({
          seller: seller.publicKey,
          mint,
          listing: listingPda,
          sellerNftAta: attackerAtaAcc.address,
          escrowNftAta: escrow,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([seller])
        .rpc();

      assert.fail("Should have failed");
    } catch (err: any) {
      const code = err?.error?.errorCode?.code;
      assert.equal(code, "ConstraintTokenOwner", "Expected error not received");
    }
  });

  it("cancel: fails if escrow ATA is invalid", async () => {
    const { seller, mint, sellerAta, buyerAta } = await setupFreshNft();
    const priceLamports = Math.floor(0.2 * LAMPORTS_PER_SOL);
    const price = new anchor.BN(priceLamports);

    const [listingPda] = deriveListingPda(mint);
    const escrow = await deriveEscrowAta(mint, listingPda);

    await program.methods
      .list(price)
      .accounts({
        seller: seller.publicKey,
        mint,
        listing: listingPda,
        sellerNftAta: sellerAta,
        escrowNftAta: escrow,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([seller])
      .rpc();

    const fakeEscrow = buyerAta;

    try {
      await program.methods
        .cancel()
        .accounts({
          seller: seller.publicKey,
          mint,
          listing: listingPda,
          sellerNftAta: sellerAta,
          escrowNftAta: fakeEscrow,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([seller])
        .rpc();

      assert.fail("Should have failed");
    } catch (err: any) {
      const code = err?.error?.errorCode?.code;
      assert.equal(code, "ConstraintTokenOwner", "Expected error not received");
    }
  });

  // -------------------------------
  // Failure tests: buy()
  // -------------------------------

  it("buy: fails if wrong seller account is provided", async () => {
    const { seller, buyer, mint, sellerAta, buyerAta } = await setupFreshNft();
    const priceLamports = Math.floor(0.2 * LAMPORTS_PER_SOL);
    const price = new anchor.BN(priceLamports);

    const [listingPda] = deriveListingPda(mint);
    const escrow = await deriveEscrowAta(mint, listingPda);

    await program.methods
      .list(price)
      .accounts({
        seller: seller.publicKey,
        mint,
        listing: listingPda,
        sellerNftAta: sellerAta,
        escrowNftAta: escrow,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([seller])
      .rpc();

    const wrongSeller = Keypair.generate();
    await airdrop(wrongSeller.publicKey, 1);

    try {
      await program.methods
        .buy()
        .accounts({
          buyer: buyer.publicKey,
          seller: wrongSeller.publicKey, // wrong seller
          mint,
          listing: listingPda,
          escrowNftAta: escrow,
          buyerNftAta: buyerAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([buyer])
        .rpc();

      assert.fail("Should have failed");
    } catch (err: any) {
      const code = err?.error?.errorCode?.code;
      assert.equal(code, "ConstraintHasOne", "Expected error not received");
    }
  });

  it("buy: fails if escrow ATA is invalid", async () => {
    const { seller, buyer, mint, sellerAta, buyerAta } = await setupFreshNft();
    const priceLamports = Math.floor(0.2 * LAMPORTS_PER_SOL);
    const price = new anchor.BN(priceLamports);

    const [listingPda] = deriveListingPda(mint);
    const escrow = await deriveEscrowAta(mint, listingPda);

    await program.methods
      .list(price)
      .accounts({
        seller: seller.publicKey,
        mint,
        listing: listingPda,
        sellerNftAta: sellerAta,
        escrowNftAta: escrow,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([seller])
      .rpc();

    const fakeEscrow = buyerAta;

    try {
      await program.methods
        .buy()
        .accounts({
          buyer: buyer.publicKey,
          seller: seller.publicKey,
          mint,
          listing: listingPda,
          escrowNftAta: fakeEscrow,
          buyerNftAta: buyerAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([buyer])
        .rpc();

      assert.fail("Should have failed");
    } catch (err: any) {
      const code = err?.error?.errorCode?.code;
      assert.equal(code, "ConstraintTokenOwner", "Expected error not received");
    }
  });

  it("buy: fails if buyer's ATA is invalid", async () => {
    const { seller, buyer, mint, sellerAta } = await setupFreshNft();
    const priceLamports = Math.floor(0.2 * LAMPORTS_PER_SOL);
    const price = new anchor.BN(priceLamports);

    const [listingPda] = deriveListingPda(mint);
    const escrow = await deriveEscrowAta(mint, listingPda);

    await program.methods
      .list(price)
      .accounts({
        seller: seller.publicKey,
        mint,
        listing: listingPda,
        sellerNftAta: sellerAta,
        escrowNftAta: escrow,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([seller])
      .rpc();

    // attacker's ATA (not buyer)
    const attacker = Keypair.generate();
    await airdrop(attacker.publicKey, 1);
    const attackerAtaAcc = await getOrCreateAssociatedTokenAccount(
      connection,
      attacker,
      mint,
      attacker.publicKey,
    );

    try {
      await program.methods
        .buy()
        .accounts({
          buyer: buyer.publicKey,
          seller: seller.publicKey,
          mint,
          listing: listingPda,
          escrowNftAta: escrow,
          buyerNftAta: attackerAtaAcc.address,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([buyer])
        .rpc();

      assert.fail("Should have failed");
    } catch (err: any) {
      const code = err?.error?.errorCode?.code;
      assert.equal(code, "ConstraintTokenOwner", "Expected error not received");
    }
  });

  it("buy: fails if self-buy", async () => {
    const { seller, buyer, mint, sellerAta, buyerAta } = await setupFreshNft({
      buyerIsSeller: true,
    });
    const priceLamports = Math.floor(0.2 * LAMPORTS_PER_SOL);
    const price = new anchor.BN(priceLamports);

    const [listingPda] = deriveListingPda(mint);
    const escrow = await deriveEscrowAta(mint, listingPda);

    await program.methods
      .list(price)
      .accounts({
        seller: seller.publicKey,
        mint,
        listing: listingPda,
        sellerNftAta: sellerAta,
        escrowNftAta: escrow,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([seller])
      .rpc();

    try {
      await program.methods
        .buy()
        .accounts({
          buyer: buyer.publicKey,
          seller: seller.publicKey,
          mint,
          listing: listingPda,
          escrowNftAta: escrow,
          buyerNftAta: buyerAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([buyer])
        .rpc();

      assert.fail("Should have failed");
    } catch (err: any) {
      assert.include(
        err.toString(),
        "SelfBuyNotAllowed",
        "Expected self buy not allowed error not received",
      );
    }
  });

  it("buy: fails when buyer has insufficient funds", async () => {
    const { seller, mint, sellerAta } = await setupFreshNft();
    const priceLamports = 1 * LAMPORTS_PER_SOL;
    const price = new anchor.BN(priceLamports);
    const [listingPda] = deriveListingPda(mint);
    const escrow = await deriveEscrowAta(mint, listingPda);

    await program.methods
      .list(price)
      .accounts({
        seller: seller.publicKey,
        mint,
        listing: listingPda,
        sellerNftAta: sellerAta,
        escrowNftAta: escrow,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([seller])
      .rpc();

    const poorBuyer = Keypair.generate();
    await airdrop(poorBuyer.publicKey, 0.01); // 0.01 SOL
    const poorBuyerAtaAcc = await getOrCreateAssociatedTokenAccount(
      connection,
      poorBuyer,
      mint,
      poorBuyer.publicKey,
    );

    try {
      await program.methods
        .buy()
        .accounts({
          buyer: poorBuyer.publicKey,
          seller: seller.publicKey,
          mint,
          listing: listingPda,
          escrowNftAta: escrow,
          buyerNftAta: poorBuyerAtaAcc.address,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([poorBuyer])
        .rpc();

      assert.fail("Should have failed");
    } catch (err: any) {
      assert.include(
        err.toString(),
        "InsufficientFunds",
        "Expected insufficient funds error not received",
      );
    }
  });

  it("buy: fails on second purchase", async () => {
    const { seller, buyer, mint, sellerAta, buyerAta } = await setupFreshNft();
    const priceLamports = Math.floor(0.2 * LAMPORTS_PER_SOL);
    const price = new anchor.BN(priceLamports);
    const [listingPda] = deriveListingPda(mint);
    const escrow = await deriveEscrowAta(mint, listingPda);

    await program.methods
      .list(price)
      .accounts({
        seller: seller.publicKey,
        mint,
        listing: listingPda,
        sellerNftAta: sellerAta,
        escrowNftAta: escrow,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([seller])
      .rpc();

    await program.methods
      .buy()
      .accounts({
        buyer: buyer.publicKey,
        seller: seller.publicKey,
        mint,
        listing: listingPda,
        escrowNftAta: escrow,
        buyerNftAta: buyerAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([buyer])
      .rpc();

    // second buy should fail because listing is closed
    try {
      await program.methods
        .buy()
        .accounts({
          buyer: buyer.publicKey,
          seller: seller.publicKey,
          mint,
          listing: listingPda,
          escrowNftAta: escrow,
          buyerNftAta: buyerAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([buyer])
        .rpc();

      assert.fail("Should have failed");
    } catch (err: any) {
      const code = err?.error?.errorCode?.code;
      assert.equal(
        code,
        "AccountNotInitialized",
        "Expected error not received",
      );
    }
  });
});
