import { createHmac, timingSafeEqual } from "node:crypto";

export function hmacHex(secret: string, message: string): string {
  return createHmac("sha256", secret).update(message).digest("hex");
}

export function internalSignature(
  secret: string,
  timestamp: string,
  path: string,
  body: string
): string {
  return hmacHex(secret, `${timestamp}\n${path}\n${body}`);
}

export function playgroundSignature(
  secret: string,
  userID: string,
  timestamp: string,
  method: string,
  path: string
): string {
  return hmacHex(secret, `${userID}\n${timestamp}\n${method}\n${path}`);
}

export function timingSafeEqualHex(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  if (left.length === 0 || left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function signaturesMatch(expectedHex: string, providedHex: string): boolean {
  try {
    return timingSafeEqualHex(expectedHex, providedHex);
  } catch {
    return false;
  }
}
