import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  hmacHex,
  internalSignature,
  playgroundSignature,
  signaturesMatch,
  timingSafeEqualHex,
} from "#crypto/signature.ts";

describe("hmacHex", () => {
  it("computes known sha256 hmacs", () => {
    assert.equal(
      hmacHex("key", "The quick brown fox jumps over the lazy dog"),
      "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8"
    );
  });
});

describe("signatures", () => {
  it("signs internal requests", () => {
    assert.equal(internalSignature("s", "1", "/p", "{}"), hmacHex("s", "1\n/p\n{}"));
  });

  it("signs playground requests", () => {
    assert.equal(playgroundSignature("s", "u", "1", "GET", "/p"), hmacHex("s", "u\n1\nGET\n/p"));
  });
});

describe("timingSafeEqualHex", () => {
  it("compares equal buffers", () => {
    assert.equal(timingSafeEqualHex("abcd", "abcd"), true);
    assert.equal(timingSafeEqualHex("abcd", "abce"), false);
  });

  it("rejects mismatched and empty values", () => {
    assert.equal(timingSafeEqualHex("", "abcd"), false);
    assert.equal(timingSafeEqualHex("abcd", "abcdef"), false);
  });
});

describe("signaturesMatch", () => {
  it("matches and mismatches safely", () => {
    assert.equal(signaturesMatch("abcd", "abcd"), true);
    assert.equal(signaturesMatch("abcd", "abce"), false);
    assert.equal(signaturesMatch("zz", "zz"), false);
  });
});
