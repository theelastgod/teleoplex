import assert from "node:assert/strict";
import { createPrivateKey, sign } from "node:crypto";
import test from "node:test";
import { Keypair } from "@solana/web3.js";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { issueChallenge, verifyChallenge } from "../lib/auth.js";

test("a solana wallet signature opens a challenge", async () => {
  const keypair = Keypair.generate();
  const address = keypair.publicKey.toBase58();
  const { nonce, message } = issueChallenge(address, "solana");
  const key = createPrivateKey({
    key: {
      kty: "OKP",
      crv: "Ed25519",
      x: Buffer.from(keypair.secretKey.slice(32)).toString("base64url"),
      d: Buffer.from(keypair.secretKey.slice(0, 32)).toString("base64url"),
    },
    format: "jwk",
  });
  const signature = sign(null, Buffer.from(message), key).toString("base64");
  const proof = await verifyChallenge({ address, chain: "solana", nonce, signature });
  assert.equal(proof.address, address);
  await assert.rejects(verifyChallenge({ address, chain: "solana", nonce, signature }), /expired/);
});

test("an ethereum wallet signature opens a challenge", async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const { nonce, message } = issueChallenge(account.address, "evm");
  const signature = await account.signMessage({ message });
  const proof = await verifyChallenge({
    address: account.address.toUpperCase(),
    chain: "evm",
    nonce,
    signature,
  });
  assert.equal(proof.address, account.address.toLowerCase());
});
