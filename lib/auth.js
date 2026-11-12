import { createPublicKey, randomBytes, verify as verifyEd25519 } from "node:crypto";
import { verifyMessage } from "viem";

const challenges = new Map();
const CHALLENGE_MS = 5 * 60 * 1000;

function normalize(chain, address) {
  const text = String(address || "").trim();
  if (chain === "evm") return text.toLowerCase();
  return text;
}

export function issueChallenge(address, chain) {
  const kind = chain === "evm" ? "evm" : "solana";
  const id = normalize(kind, address);
  if (!id) throw new Error("The wallet address is missing.");
  const nonce = randomBytes(16).toString("hex");
  const message = `TELEOPLEX\nSign in to the pad.\n${kind}\n${id}\n${nonce}`;
  challenges.set(nonce, { address: id, chain: kind, message, exp: Date.now() + CHALLENGE_MS });
  return { nonce, message };
}

function verifySolana(address, message, signature) {
  const keyBytes = decodeBase58(address);
  const sigBytes = Buffer.from(signature, "base64");
  if (keyBytes.length !== 32 || sigBytes.length !== 64) return false;
  const key = createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(keyBytes).toString("base64url") },
    format: "jwk",
  });
  return verifyEd25519(null, Buffer.from(message), key, sigBytes);
}

function decodeBase58(text) {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let value = 0n;
  for (const char of text) {
    const index = alphabet.indexOf(char);
    if (index < 0) throw new Error("That Solana address is not valid.");
    value = value * 58n + BigInt(index);
  }
  let hex = value.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  let bytes = Buffer.from(hex, "hex");
  let zeros = 0;
  for (const char of text) {
    if (char !== "1") break;
    zeros += 1;
  }
  if (zeros) bytes = Buffer.concat([Buffer.alloc(zeros), bytes]);
  if (bytes.length < 32) bytes = Buffer.concat([Buffer.alloc(32 - bytes.length), bytes]);
  return bytes;
}

export async function verifyChallenge({ address, chain, nonce, signature }) {
  const row = challenges.get(nonce);
  challenges.delete(nonce);
  if (!row || row.exp < Date.now()) throw new Error("That sign-in expired. Connect again.");
  const kind = chain === "evm" ? "evm" : "solana";
  const id = normalize(kind, address);
  if (!row || row.address !== id || row.chain !== kind) throw new Error("That sign-in does not match this wallet.");
  if (kind === "solana") {
    if (!verifySolana(id, row.message, signature)) throw new Error("The wallet signature did not match.");
  } else {
    const ok = await verifyMessage({ address: id, message: row.message, signature });
    if (!ok) throw new Error("The wallet signature did not match.");
  }
  return { address: id, chain: kind };
}
