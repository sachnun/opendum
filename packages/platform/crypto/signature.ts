import { createHmac, timingSafeEqual } from "node:crypto";

export function hmacHex(secret: string, message: string): string {
  return createHmac("sha256", secret).update(message).digest("hex");
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

export function equalHex(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  if (left.length === 0 || left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function signaturesMatch(expectedHex: string, providedHex: string): boolean {
  if (!/^[0-9a-f]*$/iu.test(expectedHex) || !/^[0-9a-f]*$/iu.test(providedHex)) return false;
  return equalHex(expectedHex, providedHex);
}
