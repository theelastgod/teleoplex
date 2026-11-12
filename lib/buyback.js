import { PublicKey, Transaction } from "@solana/web3.js";
import {
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createBurnInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { OnlinePumpSdk, PUMP_SDK, getBuyTokenAmountFromSolAmount } from "@pump-fun/pump-sdk";
import BN from "bn.js";
import { solanaKeypair } from "./wallets.js";

const BUYBACK_FEE_RECIPIENT = new PublicKey("5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD");
const RESERVE = 20_000_000n;

function payerFrom(secret) {
  const keypair = solanaKeypair(secret);
  return keypair;
}

export async function buybackAndBurn({ connection, mint, secret, lamports }) {
  if (!mint) {
    return { ok: false, held: true, reason: "The $TLPX mint is not set. The fee stays in the buyback wallet." };
  }
  const spend = BigInt(lamports) - RESERVE;
  if (spend <= 0n) {
    return { ok: false, held: true, reason: "The fee is smaller than the buyback reserve." };
  }
  const payer = payerFrom(secret);
  const mintKey = new PublicKey(mint);
  const sdk = new OnlinePumpSdk(connection);
  const global = await sdk.fetchGlobal();
  const state = await sdk.fetchBuyState(mintKey, payer.publicKey, TOKEN_2022_PROGRAM_ID);
  const expected = getBuyTokenAmountFromSolAmount({
    global,
    feeConfig: null,
    mintSupply: state.bondingCurve.tokenTotalSupply,
    bondingCurve: state.bondingCurve,
    amount: new BN(spend.toString()),
  });
  const minimum = BigInt(expected.toString()) * 85n / 100n;
  const ata = getAssociatedTokenAddressSync(mintKey, payer.publicKey, true, TOKEN_2022_PROGRAM_ID);
  const { blockhash } = await connection.getLatestBlockhash("finalized");
  const buy = new Transaction();
  buy.feePayer = payer.publicKey;
  buy.recentBlockhash = blockhash;
  buy.add(createAssociatedTokenAccountIdempotentInstruction(
    payer.publicKey,
    ata,
    payer.publicKey,
    mintKey,
    TOKEN_2022_PROGRAM_ID,
  ));
  buy.add(await PUMP_SDK.getBuyExactQuoteInV3InstructionRaw({
    user: payer.publicKey,
    mint: mintKey,
    spendableQuoteIn: new BN(spend.toString()),
    minTokensOut: new BN(minimum.toString()),
    tokenProgram: TOKEN_2022_PROGRAM_ID,
    quoteMint: NATIVE_MINT,
    quoteTokenProgram: TOKEN_PROGRAM_ID,
    buybackFeeRecipient: BUYBACK_FEE_RECIPIENT,
  }));
  buy.sign(payer);
  const buySignature = await connection.sendRawTransaction(buy.serialize(), { skipPreflight: false });
  await connection.confirmTransaction(buySignature, "confirmed");
  const account = await getAccount(connection, ata, "confirmed", TOKEN_2022_PROGRAM_ID);
  const burn = new Transaction();
  const next = await connection.getLatestBlockhash("finalized");
  burn.feePayer = payer.publicKey;
  burn.recentBlockhash = next.blockhash;
  burn.add(createBurnInstruction(ata, mintKey, payer.publicKey, account.amount, [], TOKEN_2022_PROGRAM_ID));
  burn.sign(payer);
  const burnSignature = await connection.sendRawTransaction(burn.serialize(), { skipPreflight: false });
  return { ok: true, held: false, buySignature, burnSignature, burned: account.amount.toString() };
}
