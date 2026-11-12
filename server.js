import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Connection, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { getAccount, getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { decryptJson, encryptJson } from "./lib/vault.js";
import {
  dataDir,
  ensureData,
  readJson,
  settings,
  writeJson,
} from "./lib/store.js";
import { createEvmWallet, createSolanaWallet, importEvmWallet, importSolanaWallet, solanaKeypair } from "./lib/wallets.js";
import { assertCoin, imageBytes } from "./lib/coin.js";
import { assertLaunchConfirm, launchCost, packPumpBundle, PUMP_DEV_EXTRA_LAMPORTS, PUMP_WALLET_OVERHEAD_LAMPORTS } from "./lib/plan.js";
import { ethToWei, lamportsToSol, solToLamports, unitsToRaw, weiToEth } from "./lib/curve.js";
import { buildPumpTrade, buildPumpTransactions, pumpTradeFloor, quotePumpLaunch, sendJitoBundle, uploadPumpMetadata } from "./lib/pump.js";
import { buildSplTransactions, quoteSplLaunch } from "./lib/spl.js";
import { ponsTradeMinimum, quotePonsLegs, readPonsLaunch, robinhoodChain, sendPonsLaunch, sendPonsTrade } from "./lib/robinhood.js";
import { HIP1_STEPS } from "./lib/hyperliquid.js";
import { readSpotDeploy, sendSpotDeploy } from "./lib/hl.js";
import { feeLamports, feeWallet, publicFee } from "./lib/fee.js";
import { issueChallenge, verifyChallenge } from "./lib/auth.js";
import { buybackAndBurn } from "./lib/buyback.js";


const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, "public");
const sessions = new Map();

function vaultPath() {
  return path.join(dataDir(), "vault.json");
}

function machineKey() {
  const file = path.join(dataDir(), "machine.key");
  if (!existsSync(file)) writeFileSync(file, randomBytes(32), { mode: 0o600 });
  return readFileSync(file);
}

function seal(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", machineKey(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
}

function openSeal(blob) {
  const decipher = createDecipheriv("aes-256-gcm", machineKey(), Buffer.from(blob.iv, "base64"));
  decipher.setAuthTag(Buffer.from(blob.tag, "base64"));
  const plain = Buffer.concat([decipher.update(Buffer.from(blob.data, "base64")), decipher.final()]);
  return JSON.parse(plain.toString("utf8"));
}

function accountVault(address) {
  const account = String(address).replace(/[^a-zA-Z0-9]/g, "");
  const dir = path.join(dataDir(), "accounts", account);
  mkdirSync(dir, { recursive: true });
  const keyFile = path.join(dir, "key.json");
  const file = path.join(dir, "vault.json");
  let passphrase;
  if (existsSync(keyFile)) {
    passphrase = openSeal(JSON.parse(readFileSync(keyFile, "utf8"))).passphrase;
  } else {
    passphrase = randomBytes(24).toString("hex");
    writeFileSync(keyFile, JSON.stringify(seal({ passphrase })), { mode: 0o600 });
    writeFileSync(file, JSON.stringify(encryptJson({ secrets: {} }, passphrase)));
  }
  return { account, passphrase, vaultFile: file };
}

function sessionFrom(request) {
  const header = request.headers["x-keel-session"];
  if (!header) return null;
  return sessions.get(header) || null;
}

function bookFor(current) {
  const prefix = current?.account ? `accounts/${current.account}/` : "";
  return {
    wallets: () => readJson(`${prefix}wallets.json`, []),
    saveWallets: (rows) => writeJson(`${prefix}wallets.json`, rows),
    launches: () => readJson(`${prefix}launches.json`, []),
    saveLaunches: (rows) => writeJson(`${prefix}launches.json`, rows),
  };
}

function readVault() {
  if (!existsSync(vaultPath())) return null;
  return JSON.parse(readFileSync(vaultPath(), "utf8"));
}

function requireSession(request) {
  const current = sessionFrom(request);
  if (!current?.secrets) {
    const error = new Error("Unlock the vault first.");
    error.status = 401;
    throw error;
  }
  return current;
}

function solanaUrl(current, network) {
  return network === "mainnet" || network === "mainnet-beta" ? current.solanaMainnetRpc : current.solanaRpc;
}

function connectionFor(network) {
  return new Connection(solanaUrl(settings(), network), "confirmed");
}

function walletRecord(row) {
  return { id: row.id, label: row.label, chain: row.chain, address: row.address, createdAt: row.createdAt };
}

function persistSecrets(current) {
  if (!current.passphrase) throw new Error("Unlock the vault again before saving a key.");
  const target = current.vaultFile || vaultPath();
  writeFileSync(target, JSON.stringify(encryptJson({ secrets: current.secrets }, current.passphrase)));
}

function materialize(sessionState, legs) {
  if (!Array.isArray(legs) || legs.length === 0) throw new Error("Pick at least one wallet.");
  const book = new Map(bookFor(sessionState).wallets().map((row) => [row.id, row]));
  return legs.map((leg, index) => {
    const row = book.get(leg.walletId);
    if (!row) throw new Error("A selected wallet is no longer in the book.");
    const secret = sessionState.secrets[row.id];
    if (!secret) throw new Error(`Unlock the vault to use ${row.label}.`);
    const base = {
      ...leg,
      id: row.id,
      walletId: row.id,
      label: row.label,
      chain: row.chain,
      address: row.address,
      secret,
      role: index === 0 ? "dev" : "buyer",
    };
    if (row.chain === "solana") base.keypair = solanaKeypair(secret);
    return base;
  });
}

async function quote(body) {
  const venue = body.venue;
  const legs = Array.isArray(body.legs) ? body.legs : [];
  if (legs.length === 0) throw new Error("Pick at least one wallet.");
  if (venue === "pump") {
    const quoted = quotePumpLaunch(legs);
    const packed = packPumpBundle(legs.map((leg, index) => ({
      id: leg.walletId,
      address: leg.walletId,
      role: index === 0 ? "dev" : "buyer",
    })).filter((leg, index) => index === 0 || quoted.rows.some((row) => row.id === leg.id && BigInt(row.lamports) > 0n)));
    const tip = solToLamports(settings().jitoTipSol || "0");
    const cost = launchCost({
      quotes: quoted.rows,
      tipLamports: tip,
      overheadLamports: PUMP_WALLET_OVERHEAD_LAMPORTS,
      walletCount: packed.length,
    });
    const fee = feeLamports(cost.buys);
    cost.fee = fee.toString();
    cost.total = (BigInt(cost.total) + PUMP_DEV_EXTRA_LAMPORTS + fee).toString();
    const feeInfo = publicFee();
    return {
      venue,
      rows: quoted.rows,
      percent: quoted.percentBought,
      transactions: packed,
      cost,
      costSol: lamportsToSol(cost.total),
      feeSol: lamportsToSol(fee),
      feeAddress: feeInfo.address,
      feeMint: feeInfo.mint,
      note: "Create, the dev buy, and the other buys are one Jito bundle on mainnet. Mainnet takes 0.5% of the SOL spent and uses it to buy and burn $TLPX.",
    };
  }
  if (venue === "solana") {
    if (legs.length > 5) throw new Error("A same-block Solana mint fits 5 of your wallets.");
    const quoted = quoteSplLaunch(legs);
    return {
      venue,
      rows: quoted.rows,
      supply: quoted.supply,
      note: "A Token-2022 mint. The dev wallet keeps whatever the other wallets do not receive. Mint authority is removed in the same bundle.",
    };
  }
  if (venue === "robinhood") {
    if (legs.length > 8) throw new Error("A Robinhood launch on Teleoplex uses up to 8 wallets.");
    const current = settings();
    const launcher = body.launcher || null;
    try {
      const terms = await readPonsLaunch(current.robinhoodRpc, launcher);
      const quoted = quotePonsLegs(terms, legs, body.creatorTaxBps || 0);
      return {
        venue,
        rows: quoted.rows,
        terms: {
          launchFeeEth: terms.launchFeeEth,
          canLaunch: terms.canLaunch,
          curveFeeBps: terms.curveFeeBps,
          enabled: terms.enabled,
        },
        note: "Create and the first buy are one Pons transaction. The other wallets buy in the transactions right after, and they are exempted from the launch tax.",
      };
    } catch (error) {
      return { venue, rows: [], unavailable: true, note: error.message };
    }
  }
  if (venue === "hyperliquid") {
    if (legs.length > 12) throw new Error("Hyperliquid genesis on Teleoplex uses up to 12 wallets.");
    let auction = null;
    let auctionError = null;
    if (body.launcher) {
      try {
        auction = await readSpotDeploy(body.network || "testnet", body.launcher);
      } catch (error) {
        auctionError = error.message;
      }
    }
    return { venue, steps: HIP1_STEPS, auction, auctionError, note: "The ticker purchase is the step that spends HYPE. Later steps use the token index from that purchase." };
  }
  throw new Error("Pick a venue.");
}

async function launchPump(sessionState, body, coin, wallets) {
  const network = body.network || "devnet";
  const quoted = quotePumpLaunch(wallets);
  const buyers = wallets.slice(1).map((wallet) => {
    const row = quoted.rows.find((item) => item.id === wallet.id);
    return { ...wallet, lamports: row ? row.lamports : "0" };
  }).filter((wallet) => BigInt(wallet.lamports) > 0n);
  const devRow = quoted.rows.find((item) => item.id === wallets[0].id);
  const dev = { ...wallets[0], lamports: devRow ? devRow.lamports : "0" };
  const plan = {
    mint: null,
    rows: quoted.rows,
    bundle: packPumpBundle([dev, ...buyers]),
    network,
  };
  if (body.spend !== true) return { sent: false, ...plan };
  const live = assertLaunchConfirm({ network, ticker: coin.symbol, confirm: body.confirm, spend: true }).live;
  const image = imageBytes(coin);
  if (!image) throw new Error("Pump.fun needs a PNG, JPEG, GIF, or WebP.");
  const uri = await uploadPumpMetadata(coin, image);
  const connection = connectionFor(network);
  const { blockhash } = await connection.getLatestBlockhash("finalized");
  const tip = solToLamports(settings().jitoTipSol || "0.005");
  const fee = live ? feeLamports(quoted.rows.reduce((sum, row) => sum + BigInt(row.lamports), 0n)) : 0n;
  const treasury = fee > 0n ? feeWallet() : null;
  const built = await buildPumpTransactions({
    dev,
    buyers,
    coin: { ...coin, uri },
    tipLamports: tip,
    blockhash,
    slippageBps: Number(settings().slippageBps || 100),
    includeTip: live,
    feeLamports: fee,
    feeAddress: treasury?.address || "",
  });
  for (const tx of built.transactions) {
    const simulated = await connection.simulateTransaction(tx);
    if (simulated.value.err) {
      const logs = (simulated.value.logs || []).slice(-8).join("\n");
      throw new Error(`Simulation failed.\n${logs || JSON.stringify(simulated.value.err)}`);
    }
  }
  const outcome = live
    ? { bundle: await sendJitoBundle(built.transactions) }
    : { signatures: await sendSequential(connection, built.transactions) };
  let buyback = null;
  if (live && fee > 0n && treasury) {
    try {
      buyback = await buybackAndBurn({
        connection,
        mint: settings().tlpxMint || "",
        secret: treasury.secret,
        lamports: fee,
      });
    } catch (error) {
      buyback = { ok: false, held: true, reason: error.message };
    }
  }
  const saved = remember({
    venue: "pump",
    network,
    name: coin.name,
    symbol: coin.symbol,
    mint: built.mint,
    uri,
    wallets: [dev, ...buyers].map((wallet) => ({ id: wallet.id, address: wallet.address, role: wallet.role })),
    fee: fee.toString(),
    buyback,
    outcome,
  }, sessionState);
  return { sent: true, ...saved, ...outcome, buyback };
}

async function launchSolana(sessionState, body, coin, wallets) {
  const network = body.network || "devnet";
  const quoted = quoteSplLaunch(wallets);
  if (body.spend !== true) {
    return { sent: false, rows: quoted.rows, supply: quoted.supply, network };
  }
  const live = assertLaunchConfirm({ network, ticker: coin.symbol, confirm: body.confirm, spend: true }).live;
  const connection = connectionFor(network);
  const { blockhash } = await connection.getLatestBlockhash("finalized");
  const recipients = wallets.slice(1).map((wallet) => ({
    ...wallet,
    unit: wallet.unit,
    amount: wallet.amount,
    tokens: wallet.tokens,
  }));
  const built = await buildSplTransactions({
    connection,
    dev: wallets[0],
    recipients,
    coin,
    blockhash,
    tipLamports: solToLamports(settings().jitoTipSol || "0"),
    includeTip: live,
  });
  for (const tx of built.transactions) {
    const simulated = await connection.simulateTransaction(tx);
    if (simulated.value.err) {
      const logs = (simulated.value.logs || []).slice(-8).join("\n");
      throw new Error(`Simulation failed.\n${logs || JSON.stringify(simulated.value.err)}`);
    }
  }
  const outcome = live
    ? { bundle: await sendJitoBundle(built.transactions) }
    : { signatures: await sendSequential(connection, built.transactions) };
  const saved = remember({
    venue: "solana",
    network,
    name: coin.name,
    symbol: coin.symbol,
    mint: built.mint,
    wallets: wallets.map((wallet, index) => ({ id: wallet.id, address: wallet.address, role: index === 0 ? "dev" : "buyer" })),
    outcome,
  }, sessionState);
  return { sent: true, ...saved, rows: quoted.rows, ...outcome };
}

async function launchRobinhood(sessionState, body, coin, wallets) {
  if (wallets.length > 8) throw new Error("A Robinhood launch on Teleoplex uses up to 8 wallets.");
  const current = settings();
  if (body.spend !== true) {
    const terms = await readPonsLaunch(current.robinhoodRpc, wallets[0].address).catch((error) => ({ error: error.message }));
    return { sent: false, terms, network: "mainnet" };
  }
  assertLaunchConfirm({ network: "mainnet", ticker: coin.symbol, confirm: body.confirm, spend: true });
  const salt = `0x${randomBytes(32).toString("hex")}`;
  const image = imageBytes(coin);
  let logo = coin.website || "";
  if (image) logo = `data:${image.type};base64,${coin.imageBase64}`;
  if (logo.length > 512) logo = coin.website || "https://teleoplex.local/logo";
  const outcome = await sendPonsLaunch({
    rpc: current.robinhoodRpc,
    coin: { ...coin, logo, creatorTaxBps: body.creatorTaxBps || 0 },
    dev: wallets[0],
    buyers: wallets.slice(1),
    salt,
    slippageBps: Number(current.slippageBps || 100),
  });
  const saved = remember({
    venue: "robinhood",
    network: "mainnet",
    name: coin.name,
    symbol: coin.symbol,
    mint: outcome.token,
    curve: outcome.curve,
    creatorTaxBps: Number(body.creatorTaxBps || 0),
    wallets: wallets.map((wallet, index) => ({ id: wallet.id, address: wallet.address, role: index === 0 ? "dev" : "buyer" })),
    outcome,
  }, sessionState);
  return { sent: true, ...saved };
}

async function launchHyperliquid(sessionState, body, coin, wallets) {
  if (wallets.length > 12) throw new Error("Hyperliquid genesis on Teleoplex uses up to 12 wallets.");
  const network = body.network === "mainnet" ? "mainnet" : "testnet";
  const step = body.step || "registerToken2";
  const fields = {
    symbol: coin.symbol,
    name: coin.name,
    szDecimals: body.szDecimals ?? 2,
    weiDecimals: body.weiDecimals ?? 8,
    maxGas: body.maxGas,
    token: body.token,
    maxSupply: body.maxSupply,
    noHyperliquidity: body.noHyperliquidity === true,
    quoteToken: 0,
    spot: body.spot,
    startPx: body.startPx,
    orderSz: body.orderSz,
    nOrders: body.nOrders,
    allocations: wallets.map((wallet) => ({ address: wallet.address, wei: String(wallet.amount || "0") })),
  };
  if (body.spend !== true) {
    try {
      const { actionForStep } = await import("./lib/hl.js");
      return { sent: false, step, action: actionForStep(step, fields), network };
    } catch (error) {
      return { sent: false, step, network, error: error.message };
    }
  }
  assertLaunchConfirm({ network, ticker: coin.symbol, confirm: body.confirm, spend: true });
  const outcome = await sendSpotDeploy({ network, secret: wallets[0].secret, step, fields });
  const saved = remember({
    venue: "hyperliquid",
    network,
    name: coin.name,
    symbol: coin.symbol,
    mint: fields.token != null ? String(fields.token) : "",
    wallets: wallets.map((wallet) => ({ id: wallet.id, address: wallet.address, role: wallet.role })),
    outcome,
  }, sessionState);
  return { sent: true, ...saved };
}

function remember(launch, current) {
  const row = { id: randomUUID(), createdAt: new Date().toISOString(), ...launch };
  const store = bookFor(current);
  const all = store.launches();
  all.unshift(row);
  store.saveLaunches(all.slice(0, 100));
  return row;
}

async function sendSequential(connection, transactions) {
  const signatures = [];
  for (const tx of transactions) {
    signatures.push(await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false }));
  }
  return signatures;
}

async function handle(request, response, url) {
  if (request.method === "GET" && url.pathname === "/api/state") {
    const current = sessionFrom(request);
    const store = current ? bookFor(current) : null;
    return json(response, 200, {
      locked: !current,
      hasVault: existsSync(vaultPath()),
      account: current?.accountAddress ? { address: current.accountAddress, chain: current.accountChain } : null,
      settings: settings(),
      wallets: store ? store.wallets() : [],
      launches: store ? store.launches() : [],
      fee: publicFee(),
    });
  }
  if (request.method === "POST" && url.pathname === "/api/auth/challenge") {
    const body = await readBody(request);
    return json(response, 200, issueChallenge(body.address, body.chain));
  }
  if (request.method === "POST" && url.pathname === "/api/auth/wallet") {
    const body = await readBody(request);
    const proof = await verifyChallenge(body);
    const account = accountVault(proof.address);
    const opened = decryptJson(JSON.parse(readFileSync(account.vaultFile, "utf8")), account.passphrase);
    const token = randomBytes(24).toString("hex");
    sessions.set(token, {
      token,
      secrets: opened.secrets || {},
      passphrase: account.passphrase,
      vaultFile: account.vaultFile,
      account: account.account,
      accountAddress: proof.address,
      accountChain: proof.chain,
    });
    return json(response, 200, { token, account: { address: proof.address, chain: proof.chain } });
  }
  if (request.method === "POST" && url.pathname === "/api/vault") {
    const body = await readBody(request);
    const existing = readVault();
    if (body.create) {
      if (existing) throw new Error("A vault already exists on this machine.");
      writeFileSync(vaultPath(), JSON.stringify(encryptJson({ secrets: {} }, body.passphrase)));
    }
    const blob = readVault();
    if (!blob) throw new Error("Create a passphrase before unlocking.");
    const opened = decryptJson(blob, body.passphrase);
    const token = randomBytes(24).toString("hex");
    sessions.set(token, {
      token,
      secrets: opened.secrets || {},
      passphrase: body.passphrase,
      vaultFile: vaultPath(),
    });
    return json(response, 200, { token });
  }
  if (request.method === "POST" && url.pathname === "/api/lock") {
    const current = sessionFrom(request);
    if (current) sessions.delete(current.token);
    return json(response, 200, { locked: true });
  }
  if (request.method === "POST" && url.pathname === "/api/wallets") {
    const current = requireSession(request);
    const body = await readBody(request);
    const count = Math.min(Math.max(Number(body.count) || 1, 1), 20);
    const chain = body.chain === "evm" ? "evm" : "solana";
    const created = [];
    const store = bookFor(current);
    const book = store.wallets();
    const snapshot = { ...current.secrets };
    try {
      for (let index = 0; index < count; index += 1) {
        const made = chain === "evm" ? createEvmWallet() : createSolanaWallet();
        const row = {
          id: randomUUID(),
          label: body.label || (chain === "evm" ? "EVM" : "Solana"),
          chain,
          address: made.address,
          createdAt: new Date().toISOString(),
        };
        if (count > 1) row.label = `${row.label} ${book.length + created.length + 1}`;
        book.push(row);
        current.secrets[row.id] = made.secret;
        created.push(walletRecord(row));
      }
      persistSecrets(current);
      store.saveWallets(book);
    } catch (error) {
      current.secrets = snapshot;
      throw error;
    }
    return json(response, 200, { wallets: created });
  }
  if (request.method === "POST" && url.pathname === "/api/wallets/import") {
    const current = requireSession(request);
    const body = await readBody(request);
    const made = body.chain === "evm" ? importEvmWallet(body.secret) : importSolanaWallet(body.secret);
    const row = {
      id: randomUUID(),
      label: body.label || "Imported",
      chain: made.chain,
      address: made.address,
      createdAt: new Date().toISOString(),
    };
    const store = bookFor(current);
    const book = store.wallets();
    book.push(row);
    current.secrets[row.id] = made.secret;
    persistSecrets(current);
    store.saveWallets(book);
    return json(response, 200, { wallet: walletRecord(row) });
  }
  if (request.method === "DELETE" && url.pathname.startsWith("/api/wallets/")) {
    const current = requireSession(request);
    const id = decodeURIComponent(url.pathname.slice("/api/wallets/".length));
    delete current.secrets[id];
    persistSecrets(current);
    const store = bookFor(current);
    store.saveWallets(store.wallets().filter((row) => row.id !== id));
    return json(response, 200, { removed: id });
  }
  if (request.method === "GET" && url.pathname === "/api/balances") {
    const current = settings();
    const network = url.searchParams.get("network") || current.solanaCluster;
    const signedIn = sessionFrom(request);
    const rows = signedIn ? bookFor(signedIn).wallets() : [];
    const connection = connectionFor(network);
    const evm = createPublicClient({ chain: robinhoodChain(current.robinhoodRpc), transport: http(current.robinhoodRpc) });
    const balances = await Promise.all(rows.map(async (row) => {
      try {
        if (row.chain === "solana") {
          const lamports = await connection.getBalance(new PublicKey(row.address));
          return { id: row.id, balance: lamportsToSol(lamports), unit: "SOL" };
        }
        const wei = await evm.getBalance({ address: row.address });
        return { id: row.id, balance: weiToEth(wei), unit: "ETH" };
      } catch (error) {
        return { id: row.id, balance: null, error: error.message };
      }
    }));
    return json(response, 200, { balances });
  }
  if (request.method === "POST" && url.pathname === "/api/quote") {
    return json(response, 200, await quote(await readBody(request)));
  }
  if (request.method === "POST" && url.pathname === "/api/launch") {
    const current = requireSession(request);
    const body = await readBody(request);
    const coin = assertCoin(body.venue, body.coin || {});
    const wallets = materialize(current, body.legs || []);
    const sameChain = body.venue === "pump" || body.venue === "solana" ? "solana" : "evm";
    if (wallets.some((wallet) => wallet.chain !== sameChain)) {
      throw new Error(sameChain === "solana" ? "This venue uses Solana wallets." : "This venue uses Ethereum wallets.");
    }
    const result = body.venue === "pump"
      ? await launchPump(current, body, coin, wallets)
      : body.venue === "solana"
        ? await launchSolana(current, body, coin, wallets)
        : body.venue === "robinhood"
          ? await launchRobinhood(current, body, coin, wallets)
          : await launchHyperliquid(current, body, coin, wallets);
    return json(response, 200, result);
  }
  if (request.method === "POST" && url.pathname === "/api/fund") {
    const current = requireSession(request);
    const body = await readBody(request);
    if (body.confirm !== "FUND" || body.spend !== true) {
      throw new Error("Type FUND to send this transfer.");
    }
    const wallets = materialize(current, [{ walletId: body.funderId }, ...(body.entries || []).map((entry) => ({ walletId: entry.walletId }))]);
    const funder = wallets[0];
    const entries = body.entries || [];
    if (!entries.length) throw new Error("Name a wallet to fund.");
    if (funder.chain === "solana") {
      const connection = connectionFor(body.network || "devnet");
      const signatures = [];
      for (let index = 0; index < entries.length; index += 12) {
        const slice = entries.slice(index, index + 12);
        const tx = new Transaction();
        const { blockhash } = await connection.getLatestBlockhash("finalized");
        tx.feePayer = funder.keypair.publicKey;
        tx.recentBlockhash = blockhash;
        for (const entry of slice) {
          const target = wallets.find((wallet) => wallet.id === entry.walletId);
          if (!target) throw new Error("A wallet in this transfer is no longer in the book.");
          tx.add(SystemProgram.transfer({
            fromPubkey: funder.keypair.publicKey,
            toPubkey: new PublicKey(target.address),
            lamports: solToLamports(entry.amount),
          }));
        }
        tx.sign(funder.keypair);
        signatures.push(await connection.sendRawTransaction(tx.serialize()));
      }
      return json(response, 200, { signatures });
    }
    const account = privateKeyToAccount(funder.secret);
    const chain = robinhoodChain(settings().robinhoodRpc);
    const wallet = createWalletClient({ account, chain, transport: http(settings().robinhoodRpc) });
    const hashes = [];
    for (const entry of entries) {
      const target = wallets.find((item) => item.id === entry.walletId);
      hashes.push(await wallet.sendTransaction({ to: target.address, value: ethToWei(entry.amount) }));
    }
    return json(response, 200, { hashes });
  }
  if (request.method === "POST" && url.pathname === "/api/airdrop") {
    const current = requireSession(request);
    const body = await readBody(request);
    if ((body.network || "devnet") !== "devnet") throw new Error("Airdrops are for devnet.");
    const [wallet] = materialize(current, [{ walletId: body.walletId }]);
    const connection = connectionFor("devnet");
    const signature = await connection.requestAirdrop(wallet.keypair.publicKey, solToLamports(body.amount || "1"));
    return json(response, 200, { signature });
  }
  if (request.method === "POST" && url.pathname === "/api/settings") {
    requireSession(request);
    const body = await readBody(request);
    const next = { ...settings() };
    for (const key of ["solanaCluster", "solanaRpc", "solanaMainnetRpc", "robinhoodRpc", "hyperliquidNetwork"]) {
      if (body[key] != null && body[key] !== "") next[key] = String(body[key]).trim();
    }
    if (body.tlpxMint != null) {
      const mint = String(body.tlpxMint).trim();
      if (mint && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) throw new Error("The $TLPX mint is a Solana address.");
      next.tlpxMint = mint;
    }
    if (body.jitoTipSol != null && body.jitoTipSol !== "") {
      solToLamports(body.jitoTipSol);
      next.jitoTipSol = String(body.jitoTipSol).trim();
    }
    if (body.slippageBps != null && body.slippageBps !== "") {
      const bps = Number(body.slippageBps);
      if (!Number.isInteger(bps) || bps < 0 || bps > 5000) throw new Error("Slippage is a whole number of basis points up to 5000.");
      next.slippageBps = bps;
    }
    if (next.solanaCluster !== "devnet" && next.solanaCluster !== "mainnet") {
      throw new Error("Solana cluster is devnet or mainnet.");
    }
    if (next.hyperliquidNetwork !== "testnet" && next.hyperliquidNetwork !== "mainnet") {
      throw new Error("Hyperliquid network is testnet or mainnet.");
    }
    writeJson("settings.json", next);
    return json(response, 200, { settings: next });
  }
  if (request.method === "POST" && url.pathname === "/api/trade") {
    const current = requireSession(request);
    const body = await readBody(request);
    const launch = bookFor(current).launches().find((row) => row.id === body.launchId);
    if (!launch) throw new Error("That launch is not in the book.");
    if (body.spend !== true) return json(response, 200, { sent: false, mint: launch.mint, symbol: launch.symbol });
    assertLaunchConfirm({
      network: launch.network,
      ticker: launch.symbol,
      confirm: body.confirm,
      spend: true,
    });
    if (body.side !== "buy" && body.side !== "sell") throw new Error("Pick buy or sell.");
    const wallets = materialize(current, (body.walletIds || []).map((walletId) => ({ walletId })));
    const slippageBps = Number(settings().slippageBps || 100);
    if (launch.venue === "pump") {
      const connection = connectionFor(launch.network);
      const { blockhash } = await connection.getLatestBlockhash("finalized");
      const signatures = [];
      for (const wallet of wallets) {
        let tokens = 0n;
        let lamports = 0n;
        if (body.side === "sell") {
          const pct = Number(body.amount);
          if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
            throw new Error("Sell amount is a percent of that wallet, up to 100.");
          }
          const ata = getAssociatedTokenAddressSync(new PublicKey(launch.mint), wallet.keypair.publicKey, true, TOKEN_2022_PROGRAM_ID);
          const account = await getAccount(connection, ata, "confirmed", TOKEN_2022_PROGRAM_ID);
          const bps = BigInt(Math.round(pct * 100));
          tokens = account.amount * bps / 10_000n;
          if (tokens <= 0n) throw new Error(`${wallet.label} has no tokens to sell.`);
        } else {
          lamports = solToLamports(body.amount);
        }
        const minOut = await pumpTradeFloor({
          connection,
          mint: launch.mint,
          side: body.side,
          lamports,
          tokens,
          slippageBps,
        });
        const tx = await buildPumpTrade({
          owner: wallet.keypair,
          mint: launch.mint,
          side: body.side,
          lamports,
          tokens,
          minOut,
          blockhash,
        });
        const simulated = await connection.simulateTransaction(tx);
        if (simulated.value.err) throw new Error(`Simulation failed for ${wallet.label}.`);
        signatures.push(await connection.sendRawTransaction(tx.serialize()));
      }
      return json(response, 200, { sent: true, signatures });
    }
    if (launch.venue === "robinhood") {
      if (!launch.curve) throw new Error("That launch has no curve address yet.");
      const terms = await readPonsLaunch(settings().robinhoodRpc, null);
      const feeBps = BigInt(terms.curveFeeBps || 0) + BigInt(launch.creatorTaxBps || 0);
      const hashes = [];
      for (const wallet of wallets) {
        const quoteIn = body.side === "buy" ? unitsToRaw(body.amount, 18) : 0n;
        const tokensIn = body.side === "sell" ? unitsToRaw(body.amount, 18) : 0n;
        const minOut = await ponsTradeMinimum({
          rpc: settings().robinhoodRpc,
          curve: launch.curve,
          side: body.side,
          quoteIn,
          tokensIn,
          slippageBps,
          feeBps,
        });
        hashes.push(await sendPonsTrade({
          rpc: settings().robinhoodRpc,
          curve: launch.curve,
          owner: wallet,
          side: body.side,
          quoteIn,
          tokensIn,
          minOut,
        }));
      }
      return json(response, 200, { sent: true, hashes });
    }
    throw new Error("Trading from the book is available for Pump.fun and Robinhood launches.");
  }
  if (request.method === "GET" && !url.pathname.startsWith("/api/")) {
    return serveStatic(response, url.pathname);
  }
  json(response, 404, { error: "Not found." });
}

function serveStatic(response, pathname) {
  const cleaned = decodeURIComponent(pathname).replace(/^[/\\]+/, "");
  const relative = cleaned === "" ? "index.html" : path.normalize(cleaned);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    response.writeHead(404);
    response.end("Not found.");
    return;
  }
  const file = path.resolve(publicDir, relative);
  const root = path.resolve(publicDir);
  if (!file.startsWith(root + path.sep) || !existsSync(file)) {
    response.writeHead(404);
    response.end("Not found.");
    return;
  }
  const type = file.endsWith(".css")
    ? "text/css"
    : file.endsWith(".js")
      ? "text/javascript"
      : file.endsWith(".svg")
        ? "image/svg+xml"
        : file.endsWith(".png")
          ? "image/png"
          : file.endsWith(".jpg") || file.endsWith(".jpeg")
            ? "image/jpeg"
            : "text/html";
  const typed = type.startsWith("text/") || type === "image/svg+xml" ? `${type}; charset=utf-8` : type;
  response.writeHead(200, { "content-type": typed, "cache-control": "no-store" });
  response.end(readFileSync(file));
}

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 4_000_000) {
        reject(new Error("Request is too large."));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("Request body is not JSON."));
      }
    });
    request.on("error", reject);
  });
}

export function startServer(port = 0, host = "127.0.0.1") {
  ensureData();
  const server = createServer(async (request, response) => {
    try {
      await handle(request, response, new URL(request.url, "http://127.0.0.1"));
    } catch (error) {
      const status = error.status || 400;
      json(response, status, { error: error.message });
    }
  });
  return new Promise((resolve) => {
    server.listen(port, host, () => resolve(server));
  });
}

function lanAddresses() {
  const found = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal) found.push(entry.address);
    }
  }
  return found;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const port = Number(process.env.KEEL_PORT || 8787);
  const host = process.env.TELEOPLEX_HOST || "0.0.0.0";
  startServer(port, host).then((server) => {
    const address = server.address();
    console.log(`Teleoplex is at http://127.0.0.1:${address.port}`);
    for (const ip of lanAddresses()) console.log(`Teleoplex is at http://${ip}:${address.port}`);
  });
}

