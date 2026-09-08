import { createHmac } from "node:crypto";

export function createInternalSignature(
  secret: string,
  path: string,
  timestamp: string,
  body: string
): string {
  return createHmac("sha256", secret)
    .update(`${timestamp}\n${path}\n${body}`)
    .digest("hex");
}

export function verifyInternalSignature(
  secret: string,
  path: string,
  timestamp: string,
  signature: string,
  body: string,
  maxSkewSeconds = 120
): boolean {
  if (!secret) return false;
  const tsNumber = parseInt(timestamp, 10);
  if (isNaN(tsNumber)) return false;

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - tsNumber) > maxSkewSeconds) return false;

  const expected = createInternalSignature(secret, path, timestamp, body);
  return signature === expected;
}
