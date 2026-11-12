import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  AuthorityType,
  MINT_SIZE,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMint2Instruction,
  createMintToInstruction,
  createSetAuthorityInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { packPumpBundle } from "./plan.js";

export const SPL_DECIMALS = 6;
export const SPL_SUPPLY = 1_000_000_000n * 1_000_000n;

export function quoteSplLaunch(legs) {
  if (!legs.length) throw new Error("Pick the dev wallet.");
  const rows = legs.map((leg, index) => {
    if (index === 0) return { id: leg.walletId, tokens: 0n };
    const tokens = leg.unit === "percent"
      ? SPL_SUPPLY * BigInt(Math.round(Number(leg.amount) * 100)) / 10_000n
      : BigInt(leg.tokens || 0);
    if (tokens < 0n) throw new Error("Token amount cannot be negative.");
    return { id: leg.walletId, tokens };
  });
  const claimed = rows.slice(1).reduce((sum, row) => sum + row.tokens, 0n);
  if (claimed > SPL_SUPPLY) throw new Error("Those wallets add up to more than the supply.");
  rows[0].tokens = SPL_SUPPLY - claimed;
  return {
    rows: rows.map((row) => ({
      id: row.id,
      tokens: row.tokens.toString(),
      lamports: "0",
      percent: Number((row.tokens * 10_000n) / SPL_SUPPLY) / 100,
    })),
    supply: SPL_SUPPLY.toString(),
    percentBought: 100,
  };
}

export async function buildSplTransactions({
  connection,
  dev,
  recipients,
  coin,
  mint = Keypair.generate(),
  blockhash,
  tipLamports = 0n,
  tipAccount,
  includeTip = false,
  fixedSupply = true,
}) {
  const quoted = quoteSplLaunch([
    { walletId: dev.id },
    ...recipients.map((row) => ({
      walletId: row.id,
      unit: row.unit,
      amount: row.amount,
      tokens: row.tokens,
    })),
  ]);
  const devTokens = BigInt(quoted.rows[0].tokens);
  const transfers = recipients.map((row, index) => ({
    ...row,
    tokens: BigInt(quoted.rows[index + 1].tokens),
  })).filter((row) => row.tokens > 0n);
  const packedWallets = [
    { id: dev.id, address: dev.address, role: "dev" },
    ...transfers.map((row) => ({ id: row.id, address: row.address, role: "buyer" })),
  ];
  const packed = packPumpBundle(packedWallets);
  const rent = await connection.getMinimumBalanceForRentExemption(MINT_SIZE);
  const mintKey = mint.publicKey;
  const devAta = getAssociatedTokenAddressSync(mintKey, dev.keypair.publicKey, true, TOKEN_2022_PROGRAM_ID);
  const transactions = [];

  for (const slot of packed) {
    const tx = new Transaction();
    tx.feePayer = dev.keypair.publicKey;
    tx.recentBlockhash = blockhash;
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: slot.index === 0 ? 400_000 : 200_000 }));
    if (slot.index === 0) {
      tx.add(SystemProgram.createAccount({
        fromPubkey: dev.keypair.publicKey,
        newAccountPubkey: mintKey,
        space: MINT_SIZE,
        lamports: rent,
        programId: TOKEN_2022_PROGRAM_ID,
      }));
      tx.add(createInitializeMint2Instruction(
        mintKey,
        SPL_DECIMALS,
        dev.keypair.publicKey,
        null,
        TOKEN_2022_PROGRAM_ID,
      ));
      tx.add(createAssociatedTokenAccountIdempotentInstruction(
        dev.keypair.publicKey,
        devAta,
        dev.keypair.publicKey,
        mintKey,
        TOKEN_2022_PROGRAM_ID,
      ));
      tx.add(createMintToInstruction(
        mintKey,
        devAta,
        dev.keypair.publicKey,
        SPL_SUPPLY,
        [],
        TOKEN_2022_PROGRAM_ID,
      ));
      if (fixedSupply) {
        tx.add(createSetAuthorityInstruction(
          mintKey,
          dev.keypair.publicKey,
          AuthorityType.MintTokens,
          null,
          [],
          TOKEN_2022_PROGRAM_ID,
        ));
      }
    } else {
      const recipient = transfers.find((row) => row.id === slot.walletId);
      const ata = getAssociatedTokenAddressSync(
        mintKey,
        new PublicKey(recipient.address),
        true,
        TOKEN_2022_PROGRAM_ID,
      );
      tx.add(createAssociatedTokenAccountIdempotentInstruction(
        dev.keypair.publicKey,
        ata,
        new PublicKey(recipient.address),
        mintKey,
        TOKEN_2022_PROGRAM_ID,
      ));
      tx.add(createTransferCheckedInstruction(
        devAta,
        mintKey,
        ata,
        dev.keypair.publicKey,
        recipient.tokens,
        SPL_DECIMALS,
        [],
        TOKEN_2022_PROGRAM_ID,
      ));
    }
    if (includeTip && slot.tip && tipLamports > 0n) {
      tx.add(SystemProgram.transfer({
        fromPubkey: dev.keypair.publicKey,
        toPubkey: new PublicKey(tipAccount),
        lamports: tipLamports,
      }));
    }
    const signers = [dev.keypair];
    if (slot.index === 0) signers.push(mint);
    tx.sign(...signers);
    transactions.push(tx);
  }

  return {
    mint: mintKey.toBase58(),
    transactions,
    packed,
    name: coin.name,
    symbol: coin.symbol,
    supply: SPL_SUPPLY.toString(),
  };
}
