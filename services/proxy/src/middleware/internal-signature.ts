import { internalSignature, signaturesMatch } from "@opendum/crypto";

const INTERNAL_WINDOW_MS = 2 * 60 * 1000;

export async function validateInternalSignature(
  secret: string,
  request: Request,
  path: string,
  body: string
): Promise<boolean> {
  if (!secret.trim()) return false;
  const timestampValue = (request.headers.get("x-opendum-internal-timestamp") ?? "").trim();
  const signatureValue = (request.headers.get("x-opendum-internal-signature") ?? "").trim();
  if (!timestampValue || !signatureValue) return false;
  const timestamp = Number.parseInt(timestampValue, 10);
  if (!Number.isFinite(timestamp)) return false;
  const requestTime = timestamp * 1000;
  if (Date.now() - requestTime > INTERNAL_WINDOW_MS || requestTime - Date.now() > INTERNAL_WINDOW_MS) {
    return false;
  }
  const expected = internalSignature(secret, timestampValue, path, body);
  return signaturesMatch(expected, signatureValue);
}
