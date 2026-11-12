import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { decryptJson } from "../lib/vault.js";

const dir = mkdtempSync(path.join(tmpdir(), "keel-"));
process.env.KEEL_DATA_DIR = dir;
const { startServer } = await import("../server.js");

let server;
let base;

test.before(async () => {
  server = await startServer(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

async function call(pathname, { method = "GET", body, token } = {}) {
  const headers = {};
  if (token) headers["x-keel-session"] = token;
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(base + pathname, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed = text;
  try { parsed = JSON.parse(text); } catch { /* html */ }
  return { status: response.status, body: parsed };
}

test("the desk stays local, keeps secrets in the vault, and refuses an unconfirmed mainnet send", async () => {
  const page = await call("/");
  assert.equal(page.status, 200);
  assert.match(page.body, /Teleoplex/);
  assert.match(page.body, /app.js/);

  const locked = await call("/api/wallets", { method: "POST", body: { chain: "solana", count: 1 } });
  assert.equal(locked.status, 401);

  const opened = await call("/api/vault", { method: "POST", body: { passphrase: "correct horse", create: true } });
  assert.equal(opened.status, 200);
  const token = opened.body.token;

  const made = await call("/api/wallets", {
    method: "POST",
    token,
    body: { chain: "solana", label: "Dev", count: 1 },
  });
  assert.equal(made.status, 200);
  assert.equal(Object.hasOwn(made.body.wallets[0], "secret"), false);
  const walletId = made.body.wallets[0].id;

  const evm = await call("/api/wallets", {
    method: "POST",
    token,
    body: { chain: "evm", label: "Desk", count: 1 },
  });
  assert.equal(evm.status, 200);

  const vaultFile = readFileSync(path.join(dir, "vault.json"), "utf8");
  const bookFile = readFileSync(path.join(dir, "wallets.json"), "utf8");
  const secret = decryptJson(JSON.parse(vaultFile), "correct horse").secrets[walletId];
  assert.equal(typeof secret, "string");
  assert.equal(vaultFile.includes(secret), false);
  assert.equal(bookFile.includes(secret), false);

  const quoted = await call("/api/quote", {
    method: "POST",
    body: { venue: "pump", legs: [{ walletId, amount: "0.1", unit: "sol" }] },
  });
  assert.equal(quoted.status, 200);
  assert.ok(BigInt(quoted.body.rows[0].lamports) > 0n);
  assert.equal(quoted.body.transactions[0].kind, "create-and-buy");

  const preview = await call("/api/launch", {
    method: "POST",
    token,
    body: {
      venue: "pump",
      network: "devnet",
      spend: false,
      coin: { name: "Keel", symbol: "KEEL" },
      legs: [{ walletId, amount: "0.1", unit: "sol" }],
    },
  });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.sent, false);

  const denied = await call("/api/launch", {
    method: "POST",
    token,
    body: {
      venue: "pump",
      network: "mainnet",
      spend: true,
      confirm: "nope",
      coin: { name: "Keel", symbol: "KEEL" },
      legs: [{ walletId, amount: "0.1", unit: "sol" }],
    },
  });
  assert.equal(denied.status, 400);
  assert.match(denied.body.error, /Type KEEL/);

  const step = await call("/api/launch", {
    method: "POST",
    token,
    body: {
      venue: "hyperliquid",
      network: "testnet",
      spend: false,
      step: "registerToken2",
      coin: { name: "Keel", symbol: "KEEL" },
      legs: [{ walletId: evm.body.wallets[0].id, amount: "1" }],
    },
  });
  assert.equal(step.status, 200);
  assert.equal(step.body.sent, false);
  assert.match(step.body.error, /Max gas/);

  await call("/api/lock", { method: "POST", token, body: {} });
  const after = await call("/api/wallets", { method: "POST", token, body: { chain: "solana", count: 1 } });
  assert.equal(after.status, 401);
});
