import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

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

export function evpBytesToKey(
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

export function pkcs7Unpad(data: Buffer, blockSize: number): Buffer {
  if (data.length === 0 || data.length % blockSize !== 0) {
    throw new Error("invalid PKCS7 data");
  }
  const padding = data[data.length - 1];
  if (padding === 0 || padding > blockSize || padding > data.length) {
    throw new Error("invalid PKCS7 padding");
  }
  for (const byte of data.subarray(data.length - padding)) {
    if (byte !== padding) {
      throw new Error("invalid PKCS7 padding bytes");
    }
  }
  return data.subarray(0, data.length - padding);
}

export function decrypt(passphrase: string, ciphertext: string): string {
  const raw = Buffer.from(ciphertext, "base64");
  if (
    raw.length < OPENSSL_SALT_HEADER.length + SALT_LENGTH ||
    !raw.subarray(0, OPENSSL_SALT_HEADER.length).equals(OPENSSL_SALT_HEADER)
  ) {
    throw new Error("unsupported CryptoJS ciphertext format");
  }

  const salt = raw.subarray(OPENSSL_SALT_HEADER.length, OPENSSL_SALT_HEADER.length + SALT_LENGTH);
  const payload = raw.subarray(OPENSSL_SALT_HEADER.length + SALT_LENGTH);
  const { key, iv } = evpBytesToKey(Buffer.from(passphrase, "utf8"), salt, KEY_LENGTH, BLOCK_SIZE);

  if (payload.length === 0 || payload.length % BLOCK_SIZE !== 0) {
    throw new Error("invalid AES-CBC ciphertext length");
  }

  const decipher = createDecipheriv("aes-256-cbc", key, iv);
  const plaintext = Buffer.concat([decipher.update(payload), decipher.final()]);
  return pkcs7Unpad(plaintext, BLOCK_SIZE).toString("utf8");
}

export function encrypt(passphrase: string, plaintext: string): string {
  const salt = generateSalt();
  const { key, iv } = evpBytesToKey(Buffer.from(passphrase, "utf8"), salt, KEY_LENGTH, BLOCK_SIZE);
  const padded = pkcs7Pad(Buffer.from(plaintext, "utf8"), BLOCK_SIZE);
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  const payload = Buffer.concat([cipher.update(padded), cipher.final()]);
  return Buffer.concat([OPENSSL_SALT_HEADER, salt, payload]).toString("base64");
}
