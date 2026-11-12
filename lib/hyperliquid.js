// HIP-1 deployment is five signed actions, in order. The first one pays the
// Dutch auction in HYPE and locks the ticker. Later steps distribute supply
// to wallets you name, then open the USDC book.

export const USDC_TOKEN_INDEX = 0;

export function assertTokenSpec({ name, szDecimals, weiDecimals, fullName }) {
  const ticker = String(name || "").trim();
  if (!/^[A-Z0-9]{1,6}$/.test(ticker)) {
    throw new Error("Hyperliquid ticker is 1 to 6 letters or digits.");
  }
  const sz = Number(szDecimals);
  const wei = Number(weiDecimals);
  if (!Number.isInteger(sz) || sz < 0 || sz > 8) {
    throw new Error("Size decimals have to be a whole number from 0 to 8.");
  }
  if (!Number.isInteger(wei) || wei < 0 || wei > 18) {
    throw new Error("Wei decimals have to be a whole number from 0 to 18.");
  }
  if (sz + 5 > wei) {
    throw new Error("Wei decimals have to be at least size decimals plus 5.");
  }
  const display = fullName == null ? "" : String(fullName);
  if (display.length > 64) throw new Error("Full name is longer than 64 characters.");
  return { name: ticker, szDecimals: sz, weiDecimals: wei, fullName: display || undefined };
}

export function registerTokenAction({ spec, maxGas, fullName }) {
  const clean = assertTokenSpec({ ...spec, fullName });
  const gas = Number(maxGas);
  if (!Number.isInteger(gas) || gas <= 0) throw new Error("Max gas is the most HYPE you will pay for the ticker.");
  return {
    registerToken2: {
      spec: { name: clean.name, szDecimals: clean.szDecimals, weiDecimals: clean.weiDecimals },
      maxGas: gas,
      ...(clean.fullName ? { fullName: clean.fullName } : {}),
    },
  };
}

export function userGenesisAction({ token, allocations }) {
  const index = Number(token);
  if (!Number.isInteger(index) || index < 0) throw new Error("Token index is missing.");
  if (!Array.isArray(allocations) || allocations.length === 0) {
    throw new Error("Name at least one wallet to receive genesis supply.");
  }
  const userAndWei = allocations.map((row) => {
    const address = String(row.address || "");
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error("Genesis wallet is not an Ethereum address.");
    if (!/^\d+$/.test(String(row.wei))) throw new Error("Genesis amount is a whole number of wei.");
    return [address, String(row.wei)];
  });
  return {
    userGenesis: {
      token: index,
      userAndWei,
      existingTokenAndWei: [],
    },
  };
}

export function genesisAction({ token, maxSupply, noHyperliquidity = false }) {
  const index = Number(token);
  if (!Number.isInteger(index) || index < 0) throw new Error("Token index is missing.");
  if (!/^\d+$/.test(String(maxSupply))) throw new Error("Max supply is a whole number of wei.");
  return {
    genesis: {
      token: index,
      maxSupply: String(maxSupply),
      ...(noHyperliquidity ? { noHyperliquidity: true } : {}),
    },
  };
}

export function registerSpotAction({ baseToken, quoteToken = USDC_TOKEN_INDEX }) {
  const base = Number(baseToken);
  const quote = Number(quoteToken);
  if (!Number.isInteger(base) || base < 0) throw new Error("Base token index is missing.");
  if (!Number.isInteger(quote) || quote < 0) throw new Error("Quote token index is missing.");
  return { registerSpot: { tokens: [base, quote] } };
}

export function registerHyperliquidityAction({ spot, startPx, orderSz, nOrders }) {
  const index = Number(spot);
  const orders = Number(nOrders);
  if (!Number.isInteger(index) || index < 0) throw new Error("Spot index is missing.");
  if (!/^\d+(\.\d+)?$/.test(String(startPx))) throw new Error("Start price is missing.");
  if (!/^\d+(\.\d+)?$/.test(String(orderSz))) throw new Error("Order size is missing.");
  if (!Number.isInteger(orders) || orders <= 0) throw new Error("Order count is missing.");
  return {
    registerHyperliquidity: {
      spot: index,
      startPx: String(startPx),
      orderSz: String(orderSz),
      nOrders: orders,
    },
  };
}

export const HIP1_STEPS = [
  { id: "registerToken2", title: "Buy the ticker", detail: "Pays the Dutch auction and locks the name and decimals." },
  { id: "userGenesis", title: "Assign supply", detail: "Sends genesis balances to your own wallets." },
  { id: "genesis", title: "Set the supply", detail: "Fixes the max supply. This cannot be undone." },
  { id: "registerSpot", title: "Open the book", detail: "Lists the token against USDC." },
  { id: "registerHyperliquidity", title: "Seed the book", detail: "Optional. Places the starting hyperliquidity orders." },
];
