import assert from "node:assert/strict";
import test from "node:test";
import { feeLamports } from "../lib/fee.js";

test("a bundle fee is half a percent of the SOL spent", () => {
  assert.equal(feeLamports(0), 0n);
  assert.equal(feeLamports(10_000n), 50n);
  assert.equal(feeLamports(1_000_000_000n), 5_000_000n);
});
