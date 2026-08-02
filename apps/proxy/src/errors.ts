import { createHmac, timingSafeEqual } from "node:crypto";

export interface ErrorInfo {
  message: string;
  type: string;
  param?: string | null;
  code?: string | null;
  retryAfter?: string | null;
  retryAfterMS?: number | null;
}

export function openAIErrorBody(status: number, info: ErrorInfo): { status: number; headers: Record<string, string>; body: string } {
  if (info.type === "") info.type = "invalid_request_error";
  return {
    status,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ error: info }),
  };
}

/** Validate the HMAC internal signature (mirrors api/server.go + proxy/service.go). */
export function validateInternalSignature(secret: string, request: Request, path: string, body: Buffer | Uint8Array): boolean {
  if (secret.trim() === "") return false;
  const timestampValue = request.headers.get("X-Opendum-Internal-Timestamp")?.trim() ?? "";
  const signatureValue = request.headers.get("X-Opendum-Internal-Signature")?.trim() ?? "";
  if (timestampValue === "" || signatureValue === "") return false;
  const timestamp = Number.parseInt(timestampValue, 10);
  if (Number.isNaN(timestamp)) return false;
  const requestTime = new Date(timestamp * 1000);
  const now = Date.now();
  if (now - requestTime.getTime() > 2 * 60 * 1000 || requestTime.getTime() - now > 2 * 60 * 1000) return false;

  let provided: Buffer;
  try {
    provided = Buffer.from(signatureValue, "hex");
  } catch {
    return false;
  }
  const mac = createHmac("sha256", secret);
  mac.update(timestampValue);
  mac.update("\n");
  mac.update(path);
  mac.update("\n");
  mac.update(body);
  const expected = mac.digest();
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}
