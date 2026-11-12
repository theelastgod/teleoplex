// A Jito bundle is at most five transactions. Teleoplex puts the create and the dev
// buy in the first, one buy in each of the next, and the tip on the last.
// That is the same-block cap without an address lookup table.

export const JITO_MAX_TRANSACTIONS = 5;
export const SAME_BLOCK_WALLET_CAP = JITO_MAX_TRANSACTIONS;

export const JITO_TIP_ACCOUNTS = [
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
];

export function packPumpBundle(wallets) {
  if (!Array.isArray(wallets) || wallets.length === 0) {
    throw new Error("Pick the dev wallet.");
  }
  if (wallets.length > SAME_BLOCK_WALLET_CAP) {
    throw new Error(
      `A same-block pump bundle fits ${SAME_BLOCK_WALLET_CAP} of your wallets: the dev wallet and ${SAME_BLOCK_WALLET_CAP - 1} more. Remove ${wallets.length - SAME_BLOCK_WALLET_CAP}.`,
    );
  }
  const dev = wallets.find((wallet) => wallet.role === "dev") ?? wallets[0];
  const buyers = wallets.filter((wallet) => wallet !== dev);
  const ordered = [dev, ...buyers];
  return ordered.map((wallet, index) => ({
    index,
    kind: index === 0 ? "create-and-buy" : "buy",
    walletId: wallet.id,
    address: wallet.address,
    role: index === 0 ? "dev" : "buyer",
    tip: index === ordered.length - 1,
  }));
}

export function assertLaunchConfirm({ network, ticker, confirm, spend }) {
  const cluster = String(network || "").toLowerCase();
  const live = cluster === "mainnet" || cluster === "mainnet-beta";
  if (!live) return { live: false };
  if (spend !== true) {
    throw new Error("Mainnet stays on preview until you confirm the spend.");
  }
  const expected = String(ticker || "").trim();
  if (!expected) throw new Error("The coin needs a ticker before it can be sent.");
  if (String(confirm || "").trim() !== expected) {
    throw new Error(`Type ${expected} to send this on mainnet.`);
  }
  return { live: true };
}

export function launchCost({ quotes, tipLamports, overheadLamports, walletCount }) {
  const buys = quotes.reduce((sum, row) => sum + BigInt(row.lamports), 0n);
  const tip = BigInt(tipLamports || 0);
  const overhead = BigInt(overheadLamports || 0) * BigInt(walletCount || quotes.length);
  return {
    buys: buys.toString(),
    tip: tip.toString(),
    overhead: overhead.toString(),
    total: (buys + tip + overhead).toString(),
  };
}

export const PUMP_WALLET_OVERHEAD_LAMPORTS = 3_000_000n;
export const PUMP_DEV_EXTRA_LAMPORTS = 30_000_000n;
