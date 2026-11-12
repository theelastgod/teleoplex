import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  OnlinePumpSdk,
  PUMP_SDK,
  getBuyTokenAmountFromSolAmount,
  getSellSolAmountFromTokenAmount,
} from "@pump-fun/pump-sdk";
import BN from "bn.js";
import { freshPumpCurve, quotePumpLegs, solToLamports } from "./curve.js";
import { JITO_TIP_ACCOUNTS, packPumpBundle } from "./plan.js";

// Same buyback recipient the Pump SDK uses when it builds a buy.
const BUYBACK_FEE_RECIPIENT = new PublicKey("5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD");

export function pumpLegInputs(legs) {
  return legs.flatMap((leg) => {
    if (leg.unit === "percent") {
      const bps = Math.round(Number(leg.amount) * 100);
      if (!Number.isFinite(bps) || bps <= 0) return [];
      if (bps > 10_000) throw new Error("A wallet cannot take more than 100% of supply.");
      return [{ id: leg.walletId, bps }];
    }
    const lamports = solToLamports(leg.amount || "0");
    if (lamports <= 0n) return [];
    return [{ id: leg.walletId, lamports }];
  });
}

export function quotePumpLaunch(legs) {
  const inputs = pumpLegInputs(legs);
  if (inputs.length === 0) {
    return {
      rows: [{ id: legs[0].walletId, lamports: "0", fee: "0", tokens: "0", percent: 0 }],
      tokensBought: "0",
      percentBought: 0,
    };
  }
  return quotePumpLegs(freshPumpCurve(), inputs);
}

export async function buildPumpTransactions({
  dev,
  buyers,
  coin,
  mint = Keypair.generate(),
  tipLamports = 0n,
  tipAccount = JITO_TIP_ACCOUNTS[0],
  blockhash,
  slippageBps = 100,
  includeTip = true,
  buybackFeeRecipient = BUYBACK_FEE_RECIPIENT,
  feeLamports = 0n,
  feeAddress = "",
}) {
  const legs = [
    { id: dev.id, address: dev.address, role: "dev", lamports: dev.lamports },
    ...buyers.filter((buyer) => BigInt(buyer.lamports) > 0n).map((buyer) => ({
      id: buyer.id,
      address: buyer.address,
      role: "buyer",
      lamports: buyer.lamports,
    })),
  ];
  const packed = packPumpBundle(legs);
  const curve = freshPumpCurve();
  const quoted = quotePumpLegs(curve, legs.filter((leg) => BigInt(leg.lamports) > 0n).map((leg) => ({
    id: leg.id,
    lamports: leg.lamports,
  })));
  const tokens = new Map(quoted.rows.map((row) => [row.id, BigInt(row.tokens)]));
  const creator = dev.keypair.publicKey;
  const transactions = [];

  for (const slot of packed) {
    const wallet = slot.role === "dev" ? dev : buyers.find((buyer) => buyer.id === slot.walletId);
    const tx = new Transaction();
    tx.feePayer = wallet.keypair.publicKey;
    tx.recentBlockhash = blockhash;
    const units = slot.kind === "create-and-buy" ? 600_000 : 250_000;
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units }));
    tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }));

    if (slot.kind === "create-and-buy") {
      tx.add(await PUMP_SDK.createV2Instruction({
        mint: mint.publicKey,
        name: coin.name,
        symbol: coin.symbol,
        uri: coin.uri,
        creator,
        user: creator,
        mayhemMode: false,
        cashback: false,
        holderReward: false,
      }));
    }

    const lamports = BigInt(wallet.lamports);
    if (lamports > 0n) {
      const ata = getAssociatedTokenAddressSync(
        mint.publicKey,
        wallet.keypair.publicKey,
        true,
        TOKEN_2022_PROGRAM_ID,
      );
      tx.add(createAssociatedTokenAccountIdempotentInstruction(
        wallet.keypair.publicKey,
        ata,
        wallet.keypair.publicKey,
        mint.publicKey,
        TOKEN_2022_PROGRAM_ID,
      ));
      const expected = tokens.get(wallet.id) ?? 0n;
      const minimum = expected * BigInt(10_000 - slippageBps) / 10_000n;
      tx.add(await PUMP_SDK.getBuyExactQuoteInV3InstructionRaw({
        user: wallet.keypair.publicKey,
        mint: mint.publicKey,
        spendableQuoteIn: new BN(lamports.toString()),
        minTokensOut: new BN(minimum.toString()),
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        quoteMint: NATIVE_MINT,
        quoteTokenProgram: TOKEN_PROGRAM_ID,
        buybackFeeRecipient,
      }));
    }

    if (feeLamports > 0n && feeAddress && slot.index === 0) {
      tx.add(SystemProgram.transfer({
        fromPubkey: wallet.keypair.publicKey,
        toPubkey: new PublicKey(feeAddress),
        lamports: feeLamports,
      }));
    }
    if (includeTip && slot.tip && tipLamports > 0n) {
      tx.add(SystemProgram.transfer({
        fromPubkey: wallet.keypair.publicKey,
        toPubkey: new PublicKey(tipAccount),
        lamports: tipLamports,
      }));
    }

    const signers = [wallet.keypair];
    if (slot.kind === "create-and-buy") signers.push(mint);
    tx.sign(...signers);
    transactions.push(tx);
  }

  return { mint: mint.publicKey.toBase58(), transactions, packed };
}

export async function uploadPumpMetadata(coin, image) {
  const form = new FormData();
  form.set("name", coin.name);
  form.set("symbol", coin.symbol);
  form.set("description", coin.description || "");
  form.set("twitter", coin.twitter || "");
  form.set("telegram", coin.telegram || "");
  form.set("website", coin.website || "");
  form.set("showName", "true");
  if (image) {
    form.set("file", new Blob([image.bytes], { type: image.type }), "logo.png");
  }
  const response = await fetch("https://pump.fun/api/ipfs", { method: "POST", body: form });
  if (!response.ok) throw new Error(`Pump metadata upload failed (${response.status}).`);
  const body = await response.json();
  if (!body.metadataUri) throw new Error("Pump metadata upload did not return a URI.");
  return body.metadataUri;
}

export async function sendJitoBundle(transactions) {
  const encoded = transactions.map((tx) => Buffer.from(tx.serialize()).toString("base64"));
  const response = await fetch("https://mainnet.block-engine.jito.wtf/api/v1/bundles", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "sendBundle",
      params: [encoded, { encoding: "base64" }],
    }),
  });
  const body = await response.json();
  if (body.error) throw new Error(body.error.message || "Jito rejected the bundle.");
  return body.result;
}

export async function pumpTradeFloor({ connection, mint, side, lamports = 0n, tokens = 0n, slippageBps = 100 }) {
  const bps = Number(slippageBps);
  if (!Number.isInteger(bps) || bps < 0 || bps >= 10_000) throw new Error("Slippage is out of range.");
  const sdk = new OnlinePumpSdk(connection);
  const mintKey = new PublicKey(mint);
  const [global, feeConfig, bondingCurve] = await Promise.all([
    sdk.fetchGlobal(),
    sdk.fetchFeeConfig(),
    sdk.fetchBondingCurve(mintKey),
  ]);
  const expected = side === "sell"
    ? getSellSolAmountFromTokenAmount({
      global,
      feeConfig,
      mintSupply: global.tokenTotalSupply,
      bondingCurve,
      amount: new BN(tokens.toString()),
    })
    : getBuyTokenAmountFromSolAmount({
      global,
      feeConfig,
      mintSupply: global.tokenTotalSupply,
      bondingCurve,
      amount: new BN(lamports.toString()),
      quoteMint: NATIVE_MINT,
    });
  const minimum = BigInt(expected.toString()) * BigInt(10_000 - bps) / 10_000n;
  if (minimum <= 0n) {
    throw new Error(side === "sell" ? "That sell would return no SOL." : "That buy is too small to clear the curve.");
  }
  return minimum;
}

export async function buildPumpTrade({
  owner,
  mint,
  side,
  lamports,
  tokens,
  minOut,
  blockhash,
  buybackFeeRecipient = BUYBACK_FEE_RECIPIENT,
}) {
  const tx = new Transaction();
  tx.feePayer = owner.publicKey;
  tx.recentBlockhash = blockhash;
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 }));
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }));
  const mintKey = new PublicKey(mint);
  if (side === "buy") {
    const ata = getAssociatedTokenAddressSync(mintKey, owner.publicKey, true, TOKEN_2022_PROGRAM_ID);
    tx.add(createAssociatedTokenAccountIdempotentInstruction(
      owner.publicKey,
      ata,
      owner.publicKey,
      mintKey,
      TOKEN_2022_PROGRAM_ID,
    ));
    tx.add(await PUMP_SDK.getBuyExactQuoteInV3InstructionRaw({
      user: owner.publicKey,
      mint: mintKey,
      spendableQuoteIn: new BN(lamports.toString()),
      minTokensOut: new BN((minOut ?? 0n).toString()),
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      quoteMint: NATIVE_MINT,
      quoteTokenProgram: TOKEN_PROGRAM_ID,
      buybackFeeRecipient,
    }));
  } else {
    tx.add(await PUMP_SDK.getSellV3InstructionRaw({
      user: owner.publicKey,
      mint: mintKey,
      amount: new BN(tokens.toString()),
      quoteAmount: new BN((minOut ?? 0n).toString()),
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      quoteMint: NATIVE_MINT,
      quoteTokenProgram: TOKEN_PROGRAM_ID,
      buybackFeeRecipient,
    }));
  }
  tx.sign(owner);
  return tx;
}
