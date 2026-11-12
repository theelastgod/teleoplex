import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

const KEY_LEN = 32;

function keyFrom(passphrase, salt) {
  if (typeof passphrase !== "string" || passphrase.length < 8) {
    throw new Error("Passphrase needs at least 8 characters.");
  }
  return scryptSync(passphrase, salt, KEY_LEN, { N: 16384, r: 8, p: 1 });
}

export function encryptJson(value, passphrase) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = keyFrom(passphrase, salt);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return {
    v: 1,
    kdf: "scrypt",
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: encrypted.toString("base64"),
  };
}

export function decryptJson(blob, passphrase) {
  if (!blob || blob.v !== 1) throw new Error("This vault is not a Teleoplex vault.");
  const salt = Buffer.from(blob.salt, "base64");
  const iv = Buffer.from(blob.iv, "base64");
  const tag = Buffer.from(blob.tag, "base64");
  const data = Buffer.from(blob.data, "base64");
  const key = keyFrom(passphrase, salt);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  try {
    const plain = Buffer.concat([decipher.update(data), decipher.final()]);
    return JSON.parse(plain.toString("utf8"));
  } catch {
    throw new Error("That passphrase does not open this vault.");
  }
}
