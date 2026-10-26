import { describe, expect, it } from "bun:test";
import { decrypt, encrypt, hashString } from "@opendum/core/crypto/cryptojs";

describe("cryptojs", () => {
  const secret = "test-secret";

  it("round-trips plaintexts of every block alignment", () => {
    for (const length of [0, 1, 15, 16, 17, 31, 32, 33, 1353]) {
      const plaintext = "x".repeat(length);
      expect(decrypt(secret, encrypt(secret, plaintext)), `length ${length}`).toBe(plaintext);
    }
  });

  it("decrypts a token whose plaintext is not a multiple of the block size", () => {
    const token = `workos:${"eyJhbGciOiJSUzI1NiJ9.".repeat(40)}abc`;
    expect(token.length % 16).not.toBe(0);
    expect(decrypt(secret, encrypt(secret, token))).toBe(token);
  });

  it("keeps trailing characters that are not padding", () => {
    const plaintext = "sk-hyper-62edd932-43a2-4226-bd61-865b5de42e6a";
    expect(decrypt(secret, encrypt(secret, plaintext))).toBe(plaintext);
  });

  it("rejects ciphertext that is not the CryptoJS salted format", () => {
    expect(() => decrypt(secret, Buffer.from("not-salted").toString("base64"))).toThrow();
  });

  it("hashes with sha256 hex", () => {
    expect(hashString("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
