import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decrypt, encrypt, hashString } from "./cryptojs.js";

describe("cryptojs", () => {
  const secret = "test-secret";

  it("round-trips plaintexts of every block alignment", () => {
    for (const length of [0, 1, 15, 16, 17, 31, 32, 33, 1353]) {
      const plaintext = "x".repeat(length);
      assert.equal(decrypt(secret, encrypt(secret, plaintext)), plaintext, `length ${length}`);
    }
  });

  it("decrypts a token whose plaintext is not a multiple of the block size", () => {
    const token = `workos:${"eyJhbGciOiJSUzI1NiJ9.".repeat(40)}abc`;
    assert.notEqual(token.length % 16, 0);
    assert.equal(decrypt(secret, encrypt(secret, token)), token);
  });

  it("keeps trailing characters that are not padding", () => {
    const plaintext = "sk-hyper-62edd932-43a2-4226-bd61-865b5de42e6a";
    assert.equal(decrypt(secret, encrypt(secret, plaintext)), plaintext);
  });

  it("rejects ciphertext that is not the CryptoJS salted format", () => {
    assert.throws(() => decrypt(secret, Buffer.from("not-salted").toString("base64")));
  });

  it("hashes with sha256 hex", () => {
    assert.equal(hashString("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
