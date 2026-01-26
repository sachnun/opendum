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
  const key = getEncryptionKey();
  const bytes = CryptoJS.AES.decrypt(ciphertext, key);
  return bytes.toString(CryptoJS.enc.Utf8);
}

/**
 * Hash a string using SHA-256
 */
export function hashString(text: string): string {
  return CryptoJS.SHA256(text).toString();
}

/**
 * Generate a random API key
 * Format: ifp_[48 random chars]
 */
export function generateApiKey(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "ifp_";
  const randomValues = CryptoJS.lib.WordArray.random(48);
  const randomBytes = randomValues.toString();
  
  for (let i = 0; i < 48; i++) {
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
