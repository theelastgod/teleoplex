import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyPumpBuy,
  freshPumpCurve,
  lamportsForTokens,
  quoteConstantProduct,
  quotePumpBuy,
  quotePumpLegs,
  solToLamports,
} from "../lib/curve.js";
import { assertLaunchConfirm, launchCost, packPumpBundle } from "../lib/plan.js";
import { decryptJson, encryptJson } from "../lib/vault.js";
import { LAUNCH_AND_BUY_SELECTOR, encodeLaunchAndBuy } from "../lib/pons.js";
import {
  genesisAction,
  registerSpotAction,
  registerTokenAction,
  userGenesisAction,
} from "../lib/hyperliquid.js";

test("a later pump buy pays more for the same share", () => {
  const curve = freshPumpCurve();
  const first = applyPumpBuy(curve, solToLamports("1"));
  const second = applyPumpBuy(first.next, solToLamports("1"));
  assert.ok(first.tokensOut > second.tokensOut);
  assert.equal(first.next.realToken, curve.realToken - first.tokensOut);
});

test("lamports for a token target round-trips", () => {
  const curve = freshPumpCurve();
  const target = curve.supply / 50n;
  const lamports = lamportsForTokens(curve, target);
  const quoted = quotePumpBuy(curve, lamports);
  const cheaper = quotePumpBuy(curve, lamports - 1n);
  assert.ok(quoted.tokensOut >= target);
  assert.ok(cheaper.tokensOut < target);
});

test("sequential percent quotes walk the curve in order", () => {
  const curve = freshPumpCurve();
  const quoted = quotePumpLegs(curve, [
    { id: "dev", bps: 300 },
    { id: "a", bps: 200 },
    { id: "b", bps: 200 },
  ]);
  assert.equal(quoted.rows.length, 3);
  assert.ok(BigInt(quoted.rows[1].lamports) > BigInt(quoted.rows[0].lamports) * 2n / 3n);
  assert.ok(quoted.percentBought > 6.5 && quoted.percentBought < 7.5);
});

test("same-block pump bundle caps at five wallets and tips the last", () => {
  const wallets = ["dev", "a", "b", "c", "d"].map((id) => ({ id, address: id, role: id === "dev" ? "dev" : "buyer" }));
  const plan = packPumpBundle(wallets);
  assert.equal(plan[0].kind, "create-and-buy");
  assert.equal(plan.filter((row) => row.tip).length, 1);
  assert.equal(plan.at(-1).tip, true);
  assert.throws(() => packPumpBundle([...wallets, { id: "e", address: "e" }]), /5 of your wallets/);
});

test("mainnet send requires the ticker and an explicit spend", () => {
  assert.equal(assertLaunchConfirm({ network: "devnet", ticker: "KEEL", confirm: "" }).live, false);
  assert.throws(
    () => assertLaunchConfirm({ network: "mainnet-beta", ticker: "KEEL", confirm: "KEEL", spend: false }),
    /confirm the spend/,
  );
  assert.throws(
    () => assertLaunchConfirm({ network: "mainnet", ticker: "KEEL", confirm: "keel", spend: true }),
    /Type KEEL/,
  );
  assert.equal(
    assertLaunchConfirm({ network: "mainnet", ticker: "KEEL", confirm: "KEEL", spend: true }).live,
    true,
  );
});

test("launch cost adds buys, tip, and per-wallet overhead", () => {
  const cost = launchCost({
    quotes: [{ lamports: "1000" }, { lamports: "2000" }],
    tipLamports: 50,
    overheadLamports: 10,
    walletCount: 2,
  });
  assert.equal(cost.total, "3070");
});

test("vault round trip refuses a short or wrong passphrase", () => {
  const blob = encryptJson({ a: 1, secret: "kept" }, "correct horse");
  assert.deepEqual(decryptJson(blob, "correct horse"), { a: 1, secret: "kept" });
  assert.throws(() => decryptJson(blob, "wrong horse"), /does not open/);
  assert.throws(() => encryptJson({}, "short"), /8 characters/);
});

test("Pons launchAndBuy calldata uses the router selector", () => {
  const salt = `0x${"11".repeat(32)}`;
  const economics = `0x${"22".repeat(32)}`;
  const recipient = "0x0000000000000000000000000000000000000001";
  const encoded = encodeLaunchAndBuy({
    params: {
      name: "Keel",
      symbol: "KEEL",
      logo: "https://example.com/mark.png",
      description: "A coin launched from Keel.",
      socials: { twitter: "https://x.com/keel" },
      creatorFeeRecipient: recipient,
      creatorTaxBps: 0,
      buybackEnabled: false,
      expectedEconomics: economics,
      salt,
    },
    quoteIn: 10n ** 16n,
    minTokensOut: 1n,
    recipient,
    exemptions: ["0x0000000000000000000000000000000000000002"],
  });
  assert.equal(LAUNCH_AND_BUY_SELECTOR, "0xf85f8e41");
  assert.ok(encoded.data.startsWith("0xf85f8e41"));
  assert.equal(encoded.to, "0xe33e9e479df8802cb0866d5d05258bec4cf62948");
});

test("Pons opening quote shrinks as the curve fills", () => {
  const first = quoteConstantProduct({
    quoteReserve: 10n ** 18n,
    tokenReserve: 1_000_000_000n * 10n ** 18n,
    quoteIn: 10n ** 16n,
    feeBps: 100n,
  });
  const second = quoteConstantProduct({
    quoteReserve: first.nextQuote,
    tokenReserve: first.nextToken,
    quoteIn: 10n ** 16n,
    feeBps: 100n,
  });
  assert.ok(first.tokensOut > second.tokensOut);
});

test("Hyperliquid ticker and genesis actions stay inside the documented shape", () => {
  const registered = registerTokenAction({
    spec: { name: "KEEL", szDecimals: 2, weiDecimals: 8 },
    maxGas: 500,
    fullName: "Keel",
  });
  assert.equal(registered.registerToken2.spec.name, "KEEL");
  assert.throws(() => registerTokenAction({
    spec: { name: "TOOLONG", szDecimals: 2, weiDecimals: 8 },
    maxGas: 1,
  }), /6 letters/);
  assert.throws(() => registerTokenAction({
    spec: { name: "KEEL", szDecimals: 5, weiDecimals: 8 },
    maxGas: 1,
  }), /plus 5/);
  const genesis = userGenesisAction({
    token: 4,
    allocations: [{ address: "0x0000000000000000000000000000000000000001", wei: "1000" }],
  });
  assert.equal(genesis.userGenesis.userAndWei.length, 1);
  assert.deepEqual(registerSpotAction({ baseToken: 4 }).registerSpot.tokens, [4, 0]);
  assert.equal(genesisAction({ token: 4, maxSupply: "1000" }).genesis.maxSupply, "1000");
});
