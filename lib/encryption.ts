import CryptoJS from "crypto-js";

const getEncryptionKey = (): string => {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) {
    throw new Error("NEXTAUTH_SECRET is not defined");
  }
  return secret;
};

/**
 * Encrypt a string using AES-256
 */
export function encrypt(text: string): string {
  const key = getEncryptionKey();
  return CryptoJS.AES.encrypt(text, key).toString();
}

/**
 * Decrypt an AES-256 encrypted string
 */
export function decrypt(ciphertext: string): string {
  if (!ciphertext) {
    throw new Error("Cannot decrypt empty value");
  }

  // Check if data looks unencrypted (CryptoJS encrypted data starts with "U2FsdGVkX1")
  if (!ciphertext.startsWith("U2FsdGVkX1")) {
    throw new Error(
      "Data appears to be unencrypted. Expected CryptoJS encrypted format (U2FsdGVkX1...)."
    );
  }

  const key = getEncryptionKey();
  const bytes = CryptoJS.AES.decrypt(ciphertext, key);
  const decrypted = bytes.toString(CryptoJS.enc.Utf8);

  if (!decrypted) {
    throw new Error(
      "Decryption failed: invalid ciphertext or wrong encryption key. " +
      "This may occur if NEXTAUTH_SECRET was changed after data was encrypted."
    );
  }

  return decrypted;
}

/**
 * Hash a string using SHA-256
 */
export function hashString(text: string): string {
  return CryptoJS.SHA256(text).toString();
}

/**
 * Generate a random API key
 * Format: sk-[16 random chars]
 */
export function generateApiKey(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = "sk-";
  const randomValues = CryptoJS.lib.WordArray.random(16);
  const randomBytes = randomValues.toString();
  
  for (let i = 0; i < 16; i++) {
    const index = parseInt(randomBytes.substr(i * 2, 2), 16) % chars.length;
    result += chars[index];
  }
  
  return result;
}

/**
 * Get key preview (first 12 chars for display)
 */
export function getKeyPreview(key: string): string {
  return key.substring(0, 12) + "...";
}
