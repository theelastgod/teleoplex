import { createPublicClient, createWalletClient, defineChain, http, zeroAddress, decodeEventLog } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  PONS_FACTORY,
  PONS_LAUNCH_AND_BUY,
  ROBINHOOD_CHAIN_ID,
  curveAbi,
  encodeCurveBuy,
  encodeCurveSell,
  encodeLaunchAndBuy,
  factoryAbi,
  routerAbi,
} from "./pons.js";
import { ethToWei, quoteConstantProduct, quoteConstantProductSell, weiToEth } from "./curve.js";

export function robinhoodChain(rpc) {
  return defineChain({
    id: ROBINHOOD_CHAIN_ID,
    name: "Robinhood Chain",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
  });
}

function client(rpc) {
  return createPublicClient({ chain: robinhoodChain(rpc), transport: http(rpc) });
}

export async function readPonsLaunch(rpc, launcher) {
  const publicClient = client(rpc);
  const [fee, can, economics, config] = await Promise.all([
    publicClient.readContract({ address: PONS_FACTORY, abi: factoryAbi, functionName: "launchFee" }),
    launcher
      ? publicClient.readContract({ address: PONS_FACTORY, abi: factoryAbi, functionName: "canLaunch", args: [launcher] })
      : Promise.resolve(null),
    publicClient.readContract({
      address: PONS_FACTORY,
      abi: factoryAbi,
      functionName: "previewLaunchEconomics",
      args: [0n, zeroAddress],
    }),
    publicClient.readContract({ address: PONS_FACTORY, abi: factoryAbi, functionName: "getLaunchConfig", args: [0n] }),
  ]);
  return {
    launchFee: fee.toString(),
    launchFeeEth: weiToEth(fee),
    canLaunch: can,
    expectedEconomics: economics,
    supply: config.supply.toString(),
    curveFeeBps: Number(config.curveFeeBps),
    phantomQuote: config.phantomQuote.toString(),
    graduationThreshold: config.graduationThreshold.toString(),
    enabled: config.enabled,
  };
}

export function quotePonsLegs(config, legs, taxBps) {
  let quoteReserve = BigInt(config.phantomQuote);
  let tokenReserve = BigInt(config.supply);
  const feeBps = BigInt(config.curveFeeBps) + BigInt(taxBps || 0);
  const rows = [];
  for (const leg of legs) {
    const quoteIn = ethToWei(leg.amount || "0");
    if (quoteIn <= 0n) {
      rows.push({ id: leg.walletId, lamports: "0", tokens: "0", percent: 0 });
      continue;
    }
    const quoted = quoteConstantProduct({ quoteReserve, tokenReserve, quoteIn, feeBps });
    rows.push({
      id: leg.walletId,
      lamports: quoteIn.toString(),
      tokens: quoted.tokensOut.toString(),
      percent: Number((quoted.tokensOut * 10_000n) / tokenReserve) / 100,
    });
    quoteReserve = quoted.nextQuote;
    tokenReserve = quoted.nextToken;
  }
  return { rows, feeBps: feeBps.toString() };
}

export async function sendPonsLaunch({ rpc, coin, dev, buyers, salt, slippageBps }) {
  const publicClient = client(rpc);
  const account = privateKeyToAccount(dev.secret);
  const terms = await readPonsLaunch(rpc, account.address);
  if (terms.canLaunch === false) {
    throw new Error("Pons is not accepting a launch from this wallet.");
  }
  if (!terms.enabled) throw new Error("The Pons launch config is turned off.");
  const quoted = quotePonsLegs(terms, [dev, ...buyers], coin.creatorTaxBps || 0);
  const devQuote = BigInt(quoted.rows[0].lamports);
  if (devQuote <= 0n) throw new Error("The first wallet needs an ETH buy. Pons launch-and-buy requires one.");
  const minTokens = BigInt(quoted.rows[0].tokens) * BigInt(10_000 - slippageBps) / 10_000n;
  const exemptions = buyers.map((buyer) => buyer.address);
  const encoded = encodeLaunchAndBuy({
    params: {
      name: coin.name,
      symbol: coin.symbol,
      logo: coin.logo || coin.website || "https://teleoplex.local/logo",
      description: coin.description || coin.name,
      socials: {
        twitter: coin.twitter,
        telegram: coin.telegram,
        website: coin.website,
      },
      creatorFeeRecipient: account.address,
      creatorTaxBps: Number(coin.creatorTaxBps || 0),
      buybackEnabled: false,
      expectedEconomics: terms.expectedEconomics,
      salt,
    },
    quoteIn: devQuote,
    minTokensOut: minTokens > 0n ? minTokens : 1n,
    recipient: account.address,
    exemptions,
  });
  const wallet = createWalletClient({
    account,
    chain: robinhoodChain(rpc),
    transport: http(rpc),
  });
  const fee = BigInt(terms.launchFee);
  const hash = await wallet.sendTransaction({
    to: PONS_LAUNCH_AND_BUY,
    data: encoded.data,
    value: fee + devQuote,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  let token = null;
  let curve = null;
  for (const log of receipt.logs) {
    try {
      const decoded = decodeEventLog({ abi: routerAbi, data: log.data, topics: log.topics });
      if (decoded.eventName === "Launched") {
        token = decoded.args.token;
        curve = decoded.args.curve;
      }
    } catch {
      // Other contracts log in the same receipt.
    }
  }
  const follows = [];
  if (curve) {
    for (const buyer of buyers) {
      const row = quoted.rows.find((item) => item.id === buyer.walletId);
      if (!row || BigInt(row.lamports) <= 0n) continue;
      const minimum = BigInt(row.tokens) * BigInt(10_000 - slippageBps) / 10_000n;
      const buy = encodeCurveBuy({
        curve,
        quoteIn: BigInt(row.lamports),
        minTokensOut: minimum > 0n ? minimum : 1n,
        recipient: buyer.address,
      });
      const buyerWallet = createWalletClient({
        account: privateKeyToAccount(buyer.secret),
        chain: robinhoodChain(rpc),
        transport: http(rpc),
      });
      const buyHash = await buyerWallet.sendTransaction({
        to: curve,
        data: buy.data,
        value: BigInt(row.lamports),
      });
      follows.push({ walletId: buyer.walletId, hash: buyHash });
    }
  }
  return { hash, token, curve, launchFee: terms.launchFee, follows };
}

export async function ponsTradeMinimum({ rpc, curve, side, quoteIn = 0n, tokensIn = 0n, slippageBps = 100, feeBps = 0 }) {
  const bps = Number(slippageBps);
  if (!Number.isInteger(bps) || bps < 0 || bps >= 10_000) throw new Error("Slippage is out of range.");
  const [quoteReserve, tokenReserve] = await client(rpc).readContract({
    address: curve,
    abi: curveAbi,
    functionName: "getReserves",
  });
  const expected = side === "sell"
    ? quoteConstantProductSell({ quoteReserve, tokenReserve, tokensIn, feeBps }).quoteOut
    : quoteConstantProduct({ quoteReserve, tokenReserve, quoteIn, feeBps }).tokensOut;
  const minimum = expected * BigInt(10_000 - bps) / 10_000n;
  if (minimum <= 0n) {
    throw new Error(side === "sell" ? "That sell would return no ETH." : "That buy is too small to clear a floor.");
  }
  return minimum;
}

export async function sendPonsTrade({ rpc, curve, owner, side, quoteIn, tokensIn, minOut }) {
  if (minOut == null || BigInt(minOut) <= 0n) throw new Error("A trade needs a minimum out above zero.");
  const account = privateKeyToAccount(owner.secret);
  const wallet = createWalletClient({ account, chain: robinhoodChain(rpc), transport: http(rpc) });
  const data = side === "buy"
    ? encodeCurveBuy({ curve, quoteIn, minTokensOut: minOut, recipient: account.address }).data
    : encodeCurveSell({ curve, tokensIn, minQuoteOut: minOut, recipient: account.address }).data;
  return wallet.sendTransaction({
    to: curve,
    data,
    value: side === "buy" ? quoteIn : 0n,
  });
}

export { curveAbi };
