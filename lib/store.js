import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

export function dataDir() {
  return process.env.KEEL_DATA_DIR || path.join(process.cwd(), "data");
}

function file(name) {
  return path.join(dataDir(), name);
}

export function ensureData() {
  mkdirSync(dataDir(), { recursive: true });
}

export function readJson(name, fallback) {
  ensureData();
  const target = file(name);
  if (!existsSync(target)) return fallback;
  return JSON.parse(readFileSync(target, "utf8"));
}

export function writeJson(name, value) {
  ensureData();
  const target = file(name);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(value, null, 2));
}

export const DEFAULT_SETTINGS = {
  solanaCluster: "devnet",
  solanaRpc: "https://api.devnet.solana.com",
  solanaMainnetRpc: "https://solana-rpc.publicnode.com",
  robinhoodRpc: "https://rpc.mainnet.chain.robinhood.com",
  hyperliquidNetwork: "testnet",
  jitoTipSol: "0.005",
  slippageBps: 100,
};

export function settings() {
  return { ...DEFAULT_SETTINGS, ...readJson("settings.json", {}) };
}

export function publicWallets() {
  return readJson("wallets.json", []);
}

export function savePublicWallets(wallets) {
  writeJson("wallets.json", wallets);
}

export function launches() {
  return readJson("launches.json", []);
}

export function saveLaunches(rows) {
  writeJson("launches.json", rows);
}
