import { ExchangeClient, HttpTransport, InfoClient } from "@nktkas/hyperliquid";
import { privateKeyToAccount } from "viem/accounts";
import {
  genesisAction,
  registerHyperliquidityAction,
  registerSpotAction,
  registerTokenAction,
  userGenesisAction,
} from "./hyperliquid.js";

export function hyperliquidTransport(network) {
  return new HttpTransport({ isTestnet: network !== "mainnet" });
}

export async function readSpotDeploy(network, user) {
  const info = new InfoClient({ transport: hyperliquidTransport(network) });
  return info.spotDeployState({ user });
}

export function actionForStep(step, fields) {
  if (step === "registerToken2") {
    return registerTokenAction({
      spec: {
        name: fields.symbol,
        szDecimals: fields.szDecimals,
        weiDecimals: fields.weiDecimals,
      },
      maxGas: fields.maxGas,
      fullName: fields.name,
    });
  }
  if (step === "userGenesis") return userGenesisAction({ token: fields.token, allocations: fields.allocations });
  if (step === "genesis") {
    return genesisAction({
      token: fields.token,
      maxSupply: fields.maxSupply,
      noHyperliquidity: fields.noHyperliquidity,
    });
  }
  if (step === "registerSpot") {
    return registerSpotAction({ baseToken: fields.token, quoteToken: fields.quoteToken ?? 0 });
  }
  if (step === "registerHyperliquidity") {
    return registerHyperliquidityAction({
      spot: fields.spot,
      startPx: fields.startPx,
      orderSz: fields.orderSz,
      nOrders: fields.nOrders,
    });
  }
  throw new Error("Pick a Hyperliquid step.");
}

export async function sendSpotDeploy({ network, secret, step, fields }) {
  const action = actionForStep(step, fields);
  const exchange = new ExchangeClient({
    transport: hyperliquidTransport(network),
    wallet: privateKeyToAccount(secret),
  });
  const response = await exchange.spotDeploy(action);
  return { step, action, response };
}
