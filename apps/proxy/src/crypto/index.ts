import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";

const opensslSaltHeader = "Salted__";

export function hashString(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** EVP_BytesToKey: MD5-based key/iv derivation matching OpenSSL / CryptoJS. */
function evpBytesToKey(passphrase: Buffer, salt: Buffer, keyLen: number, ivLen: number): { key: Buffer; iv: Buffer } {
  const needed = keyLen + ivLen;
  let derived = Buffer.alloc(0);
  let previous = Buffer.alloc(0);

  while (derived.length < needed) {
    previous = createHash("md5").update(previous).update(passphrase).update(salt).digest();
    derived = Buffer.concat([derived, previous]);
  }

  return { key: derived.subarray(0, keyLen), iv: derived.subarray(keyLen, needed) };
}

export function decrypt(passphrase: string, ciphertext: string): string {
  const raw = Buffer.from(ciphertext, "base64");
  if (raw.length < opensslSaltHeader.length + 8 || raw.subarray(0, opensslSaltHeader.length).toString("utf8") !== opensslSaltHeader) {
    throw new Error("unsupported CryptoJS ciphertext format");
  }

  const salt = raw.subarray(opensslSaltHeader.length, opensslSaltHeader.length + 8);
  const ciphertextBytes = raw.subarray(opensslSaltHeader.length + 8);
  const { key, iv } = evpBytesToKey(Buffer.from(passphrase, "utf8"), salt, 32, 16);

  if (ciphertextBytes.length === 0 || ciphertextBytes.length % 16 !== 0) {
    throw new Error("invalid AES-CBC ciphertext length");
  }

  const decipher = createDecipheriv("aes-256-cbc", key, iv);
  const plaintext = Buffer.concat([decipher.update(ciphertextBytes), decipher.final()]);

  return plaintext.toString("utf8");
}

export function encrypt(passphrase: string, plaintext: string): string {
  const salt = randomBytes(8);
  const { key, iv } = evpBytesToKey(Buffer.from(passphrase, "utf8"), salt, 32, 16);
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  const encrypted = Buffer.concat([cipher.update(Buffer.from(plaintext, "utf8")), cipher.final()]);

  return Buffer.concat([Buffer.from(opensslSaltHeader, "utf8"), salt, encrypted]).toString("base64");
}

/** HMAC-SHA256 hex (used for internal signatures). */
export function hmacSha256Hex(secret: string, ...parts: Array<string | Buffer>): string {
  const hmac = createHmac("sha256", secret);
  for (const part of parts) hmac.update(part);
  return hmac.digest("hex");
}
