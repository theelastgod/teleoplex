import { encodeFunctionData, parseAbi, toFunctionSelector, zeroAddress } from "viem";

export const ROBINHOOD_CHAIN_ID = 4663;
export const PONS_FACTORY = "0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e";
export const PONS_LAUNCH_AND_BUY = "0xe33e9e479df8802cb0866d5d05258bec4cf62948";
export const PONS_FEE_ESCROW = "0xd3afeb2a57f70ef218aa82451c51b2fb0416ac9e";

const socials = "struct Socials { string twitter; string telegram; string discord; string website; string farcaster; }";
const tokenParams = "struct TokenParams { string name; string symbol; string logo; string description; Socials socials; address creatorFeeRecipient; uint16 creatorTaxBps; bool buybackEnabled; bytes32 expectedEconomics; bytes32 salt; }";

export const factoryAbi = parseAbi([
  socials,
  tokenParams,
  "struct LaunchConfig { uint256 supply; uint256 curveFeeBps; uint256 phantomQuote; uint256 graduationThreshold; uint24 poolFee; int24 tickSpacing; bool enabled; }",
  "function launchFee() view returns (uint256)",
  "function canLaunch(address launcher) view returns (bool)",
  "function launchConfigCount() view returns (uint256)",
  "function getLaunchConfig(uint256 id) view returns (LaunchConfig)",
  "function previewLaunchEconomics(uint256 launchConfigId, address pairToken) view returns (bytes32)",
  "function maxCreatorTaxBps() view returns (uint256)",
]);

export const routerAbi = parseAbi([
  socials,
  tokenParams,
  "function launchAndBuy(TokenParams params, uint256 launchConfigId, address pairToken, uint256 quoteIn, uint256 minTokensOut, address recipient, address[] snipeTaxExemptions) payable returns (address token, address curve, uint256 tokensOut)",
]);

export const curveAbi = parseAbi([
  "function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) payable returns (uint256 tokensOut)",
  "function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) returns (uint256 quoteOut)",
  "function getReserves() view returns (uint256 quoteReserve, uint256 tokenReserve)",
]);

export const LAUNCH_AND_BUY_SELECTOR = toFunctionSelector(
  "launchAndBuy((string,string,string,string,(string,string,string,string,string),address,uint16,bool,bytes32,bytes32),uint256,address,uint256,uint256,address,address[])",
);

const LIMITS = { name: 64, symbol: 16, logo: 512, description: 2048, social: 256 };

function clip(label, value, max) {
  const text = String(value ?? "");
  if (text.length > max) throw new Error(`${label} is longer than ${max} characters.`);
  return text;
}

export function buildTokenParams(input) {
  const socialsIn = input.socials ?? {};
  return {
    name: clip("Name", input.name, LIMITS.name),
    symbol: clip("Ticker", input.symbol, LIMITS.symbol),
    logo: clip("Logo", input.logo, LIMITS.logo),
    description: clip("Description", input.description, LIMITS.description),
    socials: {
      twitter: clip("X", socialsIn.twitter, LIMITS.social),
      telegram: clip("Telegram", socialsIn.telegram, LIMITS.social),
      discord: clip("Discord", socialsIn.discord, LIMITS.social),
      website: clip("Website", socialsIn.website, LIMITS.social),
      farcaster: clip("Farcaster", socialsIn.farcaster, LIMITS.social),
    },
    creatorFeeRecipient: input.creatorFeeRecipient,
    creatorTaxBps: Number(input.creatorTaxBps ?? 0),
    buybackEnabled: Boolean(input.buybackEnabled),
    expectedEconomics: input.expectedEconomics,
    salt: input.salt,
  };
}

export function encodeLaunchAndBuy({
  params,
  launchConfigId = 0,
  pairToken = zeroAddress,
  quoteIn,
  minTokensOut,
  recipient,
  exemptions = [],
}) {
  if (!params?.name) throw new Error("The coin needs a name.");
  if (!recipient) throw new Error("The first buy needs a recipient.");
  if (exemptions.length > 31) throw new Error("Pons accepts at most 31 extra wallets on a launch.");
  const token = buildTokenParams(params);
  const data = encodeFunctionData({
    abi: routerAbi,
    functionName: "launchAndBuy",
    args: [
      token,
      BigInt(launchConfigId),
      pairToken,
      BigInt(quoteIn),
      BigInt(minTokensOut),
      recipient,
      exemptions,
    ],
  });
  if (!data.startsWith(LAUNCH_AND_BUY_SELECTOR)) {
    throw new Error("Launch calldata does not match the Pons router.");
  }
  return { to: PONS_LAUNCH_AND_BUY, data, chainId: ROBINHOOD_CHAIN_ID };
}

export function encodeCurveBuy({ curve, quoteIn, minTokensOut, recipient }) {
  return {
    to: curve,
    data: encodeFunctionData({
      abi: curveAbi,
      functionName: "buy",
      args: [BigInt(quoteIn), BigInt(minTokensOut), recipient],
    }),
  };
}

export function encodeCurveSell({ curve, tokensIn, minQuoteOut, recipient }) {
  return {
    to: curve,
    data: encodeFunctionData({
      abi: curveAbi,
      functionName: "sell",
      args: [BigInt(tokensIn), BigInt(minQuoteOut), recipient],
    }),
  };
}
