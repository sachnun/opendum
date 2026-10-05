import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hashString, hmacHex, internalSignature, playgroundSignature } from "#crypto/index.ts";

describe("crypto index exports", () => {
  it("exposes hashing and signatures", () => {
    assert.equal(hashString("abc"), hashString("abc"));
    assert.equal(hmacHex("k", "m").length, 64);
    assert.equal(internalSignature("s", "1", "/p", ""), hmacHex("s", "1\n/p\n"));
    assert.equal(playgroundSignature("s", "u", "1", "GET", "/p"), hmacHex("s", "u\n1\nGET\n/p"));
  });
});
