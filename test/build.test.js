import assert from "node:assert/strict";
import test from "node:test";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { quoteConstantProductSell } from "../lib/curve.js";
import { JITO_TIP_ACCOUNTS } from "../lib/plan.js";
import { buildPumpTransactions } from "../lib/pump.js";
import { buildSplTransactions, quoteSplLaunch } from "../lib/spl.js";

test("a pump bundle signs the dev and the mint, and tips the last transaction", async () => {
  const dev = Keypair.generate();
  const buyer = Keypair.generate();
  const blockhash = Keypair.generate().publicKey.toBase58();
  const built = await buildPumpTransactions({
    dev: { id: "dev", address: dev.publicKey.toBase58(), keypair: dev, lamports: "100000000" },
    buyers: [{ id: "buyer", address: buyer.publicKey.toBase58(), keypair: buyer, lamports: "50000000" }],
    coin: { name: "Keel", symbol: "KEEL", uri: "https://example.com/keel.json" },
    tipLamports: 5000n,
    tipAccount: JITO_TIP_ACCOUNTS[0],
    blockhash,
    includeTip: true,
  });
  assert.equal(built.transactions.length, 2);
  assert.equal(built.transactions[0].signatures.length, 2);
  assert.equal(built.transactions[1].signatures.length, 1);
  built.transactions.forEach((tx) => tx.serialize());
  const tip = built.transactions[1].instructions.at(-1);
  assert.equal(tip.programId.toBase58(), SystemProgram.programId.toBase58());
  assert.equal(tip.keys[1].pubkey.toBase58(), JITO_TIP_ACCOUNTS[0]);
  assert.equal(new PublicKey(built.mint).toBase58(), built.mint);
});

test("a solana mint leaves the remainder with the dev wallet", async () => {
  const quoted = quoteSplLaunch([
    { walletId: "dev" },
    { walletId: "a", unit: "percent", amount: "10" },
    { walletId: "b", unit: "percent", amount: "5" },
  ]);
  assert.equal(quoted.rows[1].percent, 10);
  assert.equal(quoted.rows[2].percent, 5);
  assert.equal(quoted.rows[0].percent, 85);

  const dev = Keypair.generate();
  const other = Keypair.generate();
  const built = await buildSplTransactions({
    connection: { getMinimumBalanceForRentExemption: async () => 1461600 },
    dev: { id: "dev", address: dev.publicKey.toBase58(), keypair: dev },
    recipients: [{ id: "a", address: other.publicKey.toBase58(), unit: "percent", amount: "10" }],
    coin: { name: "Keel", symbol: "KEEL" },
    blockhash: Keypair.generate().publicKey.toBase58(),
    includeTip: false,
  });
  assert.equal(built.transactions.length, 2);
  assert.equal(built.transactions[0].signatures.length, 2);
  built.transactions.forEach((tx) => tx.serialize());
  assert.equal(built.transactions[0].feePayer.toBase58(), dev.publicKey.toBase58());
});

test("a constant-product sell pays less as the fee rises", () => {
  const low = quoteConstantProductSell({
    quoteReserve: 1_000_000_000n,
    tokenReserve: 1_000_000_000n,
    tokensIn: 10_000_000n,
    feeBps: 0,
  });
  const high = quoteConstantProductSell({
    quoteReserve: 1_000_000_000n,
    tokenReserve: 1_000_000_000n,
    tokensIn: 10_000_000n,
    feeBps: 100,
  });
  assert.ok(high.quoteOut < low.quoteOut);
  assert.ok(low.quoteOut < 1_000_000_000n);
});
