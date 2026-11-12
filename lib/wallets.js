import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

export function createSolanaWallet() {
  const keypair = Keypair.generate();
  return {
    chain: "solana",
    address: keypair.publicKey.toBase58(),
    secret: bs58.encode(keypair.secretKey),
  };
}

export function importSolanaWallet(secret) {
  const text = String(secret || "").trim();
  let bytes;
  if (text.startsWith("[")) {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) throw new Error("Solana key JSON is not an array.");
    bytes = Uint8Array.from(parsed);
  } else {
    bytes = bs58.decode(text);
  }
  if (bytes.length !== 64) throw new Error("Solana secret must be a 64-byte keypair.");
  const keypair = Keypair.fromSecretKey(bytes);
  return {
    chain: "solana",
    address: keypair.publicKey.toBase58(),
    secret: bs58.encode(keypair.secretKey),
  };
}

export function createEvmWallet() {
  const secret = generatePrivateKey();
  return { chain: "evm", address: privateKeyToAccount(secret).address, secret };
}

export function importEvmWallet(secret) {
  const text = String(secret || "").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(text)) {
    throw new Error("Ethereum secret is 0x followed by 64 hex characters.");
  }
  return { chain: "evm", address: privateKeyToAccount(text).address, secret: text };
}

export function solanaKeypair(secret) {
  return Keypair.fromSecretKey(bs58.decode(secret));
}
