import { Buffer } from "node:buffer";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const ENCRYPTION_VERSION = "v1";
const AES_256_KEY_BYTES = 32;
const AES_BLOCK_BYTES = 16;
const OPENSSL_SALTED_PREFIX = "Salted__";

const getEncryptionKey = (): string => {
  const authSecret = process.env.BETTER_AUTH_SECRET;
  if (authSecret) {
    return authSecret;
  }

  throw new Error("BETTER_AUTH_SECRET is not defined");
};

const deriveV1EncryptionKey = (): Buffer => createHash("sha256").update(getEncryptionKey()).digest();

function decryptV1(ciphertext: string): string {
  const [, ivText, tagText, encryptedText] = ciphertext.split(":");
  if (!ivText || !tagText || !encryptedText) throw new Error("Invalid encrypted payload");

  const decipher = createDecipheriv("aes-256-gcm", deriveV1EncryptionKey(), Buffer.from(ivText, "base64"));
  decipher.setAuthTag(Buffer.from(tagText, "base64"));

  return Buffer.concat([decipher.update(Buffer.from(encryptedText, "base64")), decipher.final()]).toString("utf8");
}

function deriveCryptoJsKey(passphrase: string, salt: Buffer): { key: Buffer; iv: Buffer } {
  let derived = Buffer.alloc(0);
  let block = Buffer.alloc(0);

  while (derived.length < AES_256_KEY_BYTES + AES_BLOCK_BYTES) {
    block = createHash("md5").update(block).update(passphrase, "utf8").update(salt).digest();
    derived = Buffer.concat([derived, block]);
  }

  return {
    key: derived.subarray(0, AES_256_KEY_BYTES),
    iv: derived.subarray(AES_256_KEY_BYTES, AES_256_KEY_BYTES + AES_BLOCK_BYTES),
  };
}

function encryptCryptoJsCompatible(text: string): string {
  const salt = randomBytes(8);
  const { key, iv } = deriveCryptoJsKey(getEncryptionKey(), salt);
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);

  return Buffer.concat([Buffer.from(OPENSSL_SALTED_PREFIX, "utf8"), salt, encrypted]).toString("base64");
}

function decryptCryptoJsCompatible(ciphertext: string): string {
  const encrypted = Buffer.from(ciphertext, "base64");
  if (encrypted.subarray(0, OPENSSL_SALTED_PREFIX.length).toString("utf8") !== OPENSSL_SALTED_PREFIX) throw new Error("Unsupported encrypted payload");

  const salt = encrypted.subarray(OPENSSL_SALTED_PREFIX.length, OPENSSL_SALTED_PREFIX.length + 8);
  const payload = encrypted.subarray(OPENSSL_SALTED_PREFIX.length + 8);
  const { key, iv } = deriveCryptoJsKey(getEncryptionKey(), salt);
  const decipher = createDecipheriv("aes-256-cbc", key, iv);

  return Buffer.concat([decipher.update(payload), decipher.final()]).toString("utf8");
}

/**
 * Encrypt a string using AES-256
 */
export function encrypt(text: string): string {
  return encryptCryptoJsCompatible(text);
}

/**
 * Decrypt an AES-256 encrypted string
 */
export function decrypt(ciphertext: string): string {
  if (ciphertext.startsWith(`${ENCRYPTION_VERSION}:`)) return decryptV1(ciphertext);
  return decryptCryptoJsCompatible(ciphertext);
}

/**
 * Hash a string using SHA-256
 */
export function hashString(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Generate a random API key
 * Format: sk-[16 random chars]
 */
export function generateApiKey(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = randomBytes(16);
  let result = "sk-";
  for (let i = 0; i < 16; i++) {
    result += chars[bytes[i] % chars.length];
  }
  return result;
}

/**
 * Get key preview (first 12 chars for display)
 */
export function getKeyPreview(key: string): string {
  return key.substring(0, 12) + "...";
}
