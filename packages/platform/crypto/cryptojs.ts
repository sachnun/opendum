import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { Schema } from "effect";

const OPENSSL_SALT_HEADER = Buffer.from("Salted__", "utf8");
const SALT_LENGTH = 8;
const BLOCK_SIZE = 16;
const KEY_LENGTH = 32;

export function hashString(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function generateSalt(): Buffer {
  return randomBytes(SALT_LENGTH);
}

export function evpKey(
  password: Buffer,
  salt: Buffer,
  keyLen: number,
  ivLen: number
): { key: Buffer; iv: Buffer } {
  const needed = keyLen + ivLen;
  const chunks: Buffer[] = [];
  let previous = Buffer.alloc(0);
  let total = 0;
  while (total < needed) {
    previous = createHash("md5").update(previous).update(password).update(salt).digest();
    chunks.push(previous);
    total += previous.length;
  }
  const derived = Buffer.concat(chunks);
  return { key: derived.subarray(0, keyLen), iv: derived.subarray(keyLen, needed) };
}

export function pkcs7Pad(data: Buffer, blockSize: number): Buffer {
  let padding = blockSize - (data.length % blockSize);
  if (padding === 0) padding = blockSize;
  const padded = Buffer.alloc(data.length + padding);
  data.copy(padded);
  padded.fill(padding, data.length);
  return padded;
}

export function pkcs7Unpad(data: Buffer, blockSize: number): Buffer | null {
  if (data.length === 0 || data.length % blockSize !== 0) return null;
  const padding = data[data.length - 1];
  if (padding === undefined || padding === 0 || padding > blockSize || padding > data.length) return null;
  for (const byte of data.subarray(data.length - padding)) {
    if (byte !== padding) return null;
  }
  return data.subarray(0, data.length - padding);
}

export class CiphertextFormat extends Schema.TaggedError<CiphertextFormat>()("CiphertextFormat", {
  message: Schema.String,
}) {}

export class CiphertextLength extends Schema.TaggedError<CiphertextLength>()("CiphertextLength", {
  message: Schema.String,
}) {}

export class Padding extends Schema.TaggedError<Padding>()("Padding", {
  message: Schema.String,
}) {}

export type DecryptFailure = CiphertextFormat | CiphertextLength | Padding;

export function decryptResult(
  passphrase: string,
  ciphertext: string
): { readonly ok: true; readonly value: string } | { readonly ok: false; readonly failure: DecryptFailure } {
  const raw = Buffer.from(ciphertext, "base64");
  if (
    raw.length < OPENSSL_SALT_HEADER.length + SALT_LENGTH ||
    !raw.subarray(0, OPENSSL_SALT_HEADER.length).equals(OPENSSL_SALT_HEADER)
  ) {
    return { ok: false, failure: new CiphertextFormat({ message: "unsupported CryptoJS ciphertext format" }) };
  }

  const salt = raw.subarray(OPENSSL_SALT_HEADER.length, OPENSSL_SALT_HEADER.length + SALT_LENGTH);
  const payload = raw.subarray(OPENSSL_SALT_HEADER.length + SALT_LENGTH);
  const { key, iv } = evpKey(Buffer.from(passphrase, "utf8"), salt, KEY_LENGTH, BLOCK_SIZE);

  if (payload.length === 0 || payload.length % BLOCK_SIZE !== 0) {
    return { ok: false, failure: new CiphertextLength({ message: "invalid AES-CBC ciphertext length" }) };
  }

  const decipher = createDecipheriv("aes-256-cbc", key, iv);
  decipher.setAutoPadding(false);
  const plaintext = Buffer.concat([decipher.update(payload), decipher.final()]);
  const unpadded = pkcs7Unpad(plaintext, BLOCK_SIZE);
  if (!unpadded) return { ok: false, failure: new Padding({ message: "invalid PKCS7 padding" }) };
  return { ok: true, value: unpadded.toString("utf8") };
}

export function decrypt(passphrase: string, ciphertext: string): string {
  const result = decryptResult(passphrase, ciphertext);
  return result.ok ? result.value : result.failure.message;
}

export function encrypt(passphrase: string, plaintext: string): string {
  const salt = generateSalt();
  const { key, iv } = evpKey(Buffer.from(passphrase, "utf8"), salt, KEY_LENGTH, BLOCK_SIZE);
  const padded = pkcs7Pad(Buffer.from(plaintext, "utf8"), BLOCK_SIZE);
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  cipher.setAutoPadding(false);
  const payload = Buffer.concat([cipher.update(padded), cipher.final()]);
  return Buffer.concat([OPENSSL_SALT_HEADER, salt, payload]).toString("base64");
}
