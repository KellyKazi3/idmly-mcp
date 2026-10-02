import { test } from "node:test";
import assert from "node:assert/strict";
import { unzip } from "../dist/unzip.js";

test("garbage and truncated input fail with a clear error, not a range error", () => {
  assert.throws(() => unzip(Buffer.from("nope")), /corrupt zip/);
  assert.throws(() => unzip(Buffer.alloc(0)), /corrupt zip/);
  // a valid EOCD pointing at a central directory offset past the end
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 10); eocd.writeUInt32LE(9999, 16);
  assert.throws(() => unzip(eocd), /corrupt zip/);
});
