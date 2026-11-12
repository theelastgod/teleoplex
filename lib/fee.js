import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dataDir, ensureData, settings } from "./store.js";
import { createSolanaWallet } from "./wallets.js";

export const FEE_BPS = 50n;
export const TOKEN_NAME = "TELEOPLEX";
export const TOKEN_TICKER = "TLPX";

export function feeLamports(buys) {
  const spent = BigInt(buys || 0);
  if (spent <= 0n) return 0n;
  return spent * FEE_BPS / 10_000n;
}

export function feeWallet() {
  ensureData();
  const file = path.join(dataDir(), "fee-wallet.json");
  if (!existsSync(file)) {
    const made = createSolanaWallet();
    writeFileSync(file, JSON.stringify({ address: made.address, secret: made.secret }));
    return { address: made.address, secret: made.secret };
  }
  return JSON.parse(readFileSync(file, "utf8"));
}

export function publicFee() {
  const current = settings();
  return {
    bps: Number(FEE_BPS),
    ticker: TOKEN_TICKER,
    name: TOKEN_NAME,
    address: feeWallet().address,
    mint: current.tlpxMint || "",
  };
}
