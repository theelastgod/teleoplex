// Bonding-curve quotes for a fresh pump.fun coin and a Pons constant-product curve.
// Integer math only. A live review re-reads pump.fun Global before anything is signed.

export const PUMP_SUPPLY = 1_000_000_000_000_000n; // 1e9 tokens, 6 decimals
export const PUMP_VIRTUAL_TOKEN = 1_073_000_000_000_000n;
export const PUMP_VIRTUAL_SOL = 30_000_000_000n; // 30 SOL
export const PUMP_REAL_TOKEN = 793_100_000_000_000n;
export const PUMP_FEE_BPS = 100n;

export function freshPumpCurve(patch = {}) {
  return {
    virtualSol: PUMP_VIRTUAL_SOL,
    virtualToken: PUMP_VIRTUAL_TOKEN,
    realToken: PUMP_REAL_TOKEN,
    supply: PUMP_SUPPLY,
    feeBps: PUMP_FEE_BPS,
    ...patch,
  };
}

function divCeil(numerator, denominator) {
  if (denominator <= 0n) throw new Error("Curve division by zero.");
  return (numerator + denominator - 1n) / denominator;
}

export function quotePumpBuy(state, lamportsIn) {
  const input = BigInt(lamportsIn);
  if (input <= 0n) throw new Error("Buy amount has to be greater than zero.");
  if (state.realToken <= 0n) throw new Error("This curve has no tokens left.");
  const feeBps = BigInt(state.feeBps);
  const fee = (input * feeBps) / 10_000n;
  const net = input - fee;
  if (net <= 0n) throw new Error("Buy amount is smaller than the fee.");
  const k = state.virtualSol * state.virtualToken;
  const newVirtualSol = state.virtualSol + net;
  const newVirtualToken = divCeil(k, newVirtualSol);
  let tokensOut = state.virtualToken - newVirtualToken;
  if (tokensOut > state.realToken) tokensOut = state.realToken;
  if (tokensOut <= 0n) throw new Error("Buy amount is too small to move the curve.");
  return {
    lamports: input,
    fee,
    net,
    tokensOut,
    newVirtualSol,
    newVirtualToken: state.virtualToken - tokensOut,
  };
}

export function applyPumpBuy(state, lamportsIn) {
  const quoted = quotePumpBuy(state, lamportsIn);
  return {
    ...quoted,
    next: {
      ...state,
      virtualSol: quoted.newVirtualSol,
      virtualToken: quoted.newVirtualToken,
      realToken: state.realToken - quoted.tokensOut,
    },
  };
}

// Smallest lamport input that buys at least `tokensWanted` on this state.
export function lamportsForTokens(state, tokensWanted) {
  const target = BigInt(tokensWanted);
  if (target <= 0n) throw new Error("Token target has to be greater than zero.");
  if (target > state.realToken) {
    throw new Error("That share is larger than the curve still has for sale.");
  }
  let lo = 1n;
  let hi = 1_000_000n * 1_000_000_000n;
  const top = quotePumpBuy(state, hi);
  if (top.tokensOut < target) throw new Error("Token target does not fit this curve.");
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    const quoted = quotePumpBuy(state, mid);
    if (quoted.tokensOut < target) lo = mid + 1n;
    else hi = mid;
  }
  return lo;
}

export function percentOf(tokens, supply) {
  if (supply <= 0n) return 0;
  return Number((tokens * 10_000n) / supply) / 100;
}

// legs: { id, lamports } or { id, bps } where bps is basis points of total supply.
export function quotePumpLegs(curve, legs) {
  let state = curve;
  const rows = [];
  for (const leg of legs) {
    const lamports = leg.bps != null
      ? lamportsForTokens(state, (state.supply * BigInt(leg.bps)) / 10_000n)
      : BigInt(leg.lamports);
    const applied = applyPumpBuy(state, lamports);
    rows.push({
      id: leg.id,
      lamports: applied.lamports.toString(),
      fee: applied.fee.toString(),
      tokens: applied.tokensOut.toString(),
      percent: percentOf(applied.tokensOut, state.supply),
    });
    state = applied.next;
  }
  const bought = rows.reduce((sum, row) => sum + BigInt(row.tokens), 0n);
  return {
    rows,
    tokensBought: bought.toString(),
    percentBought: percentOf(bought, curve.supply),
  };
}

// Pons opens on a constant-product curve. Fee leaves the quote before it joins the reserve.
export function quoteConstantProductSell({ quoteReserve, tokenReserve, tokensIn, feeBps }) {
  const input = BigInt(tokensIn);
  const reserveQ = BigInt(quoteReserve);
  const reserveT = BigInt(tokenReserve);
  const fee = BigInt(feeBps);
  if (input <= 0n) throw new Error("Sell amount has to be greater than zero.");
  if (reserveQ <= 0n || reserveT <= 0n) throw new Error("Curve reserves are empty.");
  const k = reserveQ * reserveT;
  const newToken = reserveT + input;
  const newQuote = divCeil(k, newToken);
  const gross = reserveQ - newQuote;
  if (gross <= 0n) throw new Error("Sell amount is too small to move the curve.");
  const taken = (gross * fee) / 10_000n;
  const quoteOut = gross - taken;
  if (quoteOut <= 0n) throw new Error("Sell amount is smaller than the fee.");
  return { tokensIn: input, fee: taken, quoteOut, nextQuote: newQuote, nextToken: newToken };
}

export function quoteConstantProduct({ quoteReserve, tokenReserve, quoteIn, feeBps }) {
  const input = BigInt(quoteIn);
  const reserveQ = BigInt(quoteReserve);
  const reserveT = BigInt(tokenReserve);
  const fee = BigInt(feeBps);
  if (input <= 0n) throw new Error("Buy amount has to be greater than zero.");
  if (reserveQ <= 0n || reserveT <= 0n) throw new Error("Curve reserves are empty.");
  const net = input - (input * fee) / 10_000n;
  if (net <= 0n) throw new Error("Buy amount is smaller than the fee.");
  const k = reserveQ * reserveT;
  const newQuote = reserveQ + net;
  const newToken = divCeil(k, newQuote);
  const tokensOut = reserveT - newToken;
  if (tokensOut <= 0n) throw new Error("Buy amount is too small to move the curve.");
  return {
    quoteIn: input,
    fee: input - net,
    tokensOut,
    nextQuote: reserveQ + net,
    nextToken: newToken,
  };
}

export function lamportsToSol(lamports) {
  const value = BigInt(lamports);
  const whole = value / 1_000_000_000n;
  const frac = (value % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

export function solToLamports(sol) {
  const text = String(sol).trim();
  if (!/^\d+(\.\d+)?$/.test(text)) throw new Error("SOL amount is not a number.");
  const [whole, frac = ""] = text.split(".");
  if (frac.length > 9) throw new Error("SOL amount has more than 9 decimal places.");
  return BigInt(whole) * 1_000_000_000n + BigInt(frac.padEnd(9, "0"));
}

export function unitsToRaw(amount, decimals) {
  const places = Number(decimals);
  if (!Number.isInteger(places) || places < 0 || places > 18) throw new Error("Decimal places are out of range.");
  const text = String(amount).trim();
  if (!/^\d+(\.\d+)?$/.test(text)) throw new Error("Amount is not a number.");
  const [whole, frac = ""] = text.split(".");
  if (frac.length > places) throw new Error(`Amount has more than ${places} decimal places.`);
  const scale = 10n ** BigInt(places);
  const fraction = frac.length ? BigInt(frac.padEnd(places, "0")) : 0n;
  return BigInt(whole) * scale + fraction;
}

export function ethToWei(eth) {
  try {
    return unitsToRaw(eth, 18);
  } catch (error) {
    throw new Error(String(error.message).replace("Amount", "ETH amount").replace("18 decimal places", "18 decimal places"));
  }
}

export function weiToEth(wei) {
  const value = BigInt(wei);
  const whole = value / 10n ** 18n;
  const frac = (value % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}
