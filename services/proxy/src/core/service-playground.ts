import type { AuthResult } from "@opendum/auth";
import { playgroundSignature, signaturesMatch } from "@opendum/crypto";

export function validatePlaygroundAuth(
  request: Request | undefined,
  secret: string
): { handled: boolean; result: AuthResult } {
  const emptyResult: AuthResult = {
    valid: false,
    userId: "",
    apiKeyId: "",
    modelAccessMode: "all",
    modelAccessList: [],
    accountAccessMode: "all",
    accountAccessList: [],
    roamingEnabled: false,
    rateLimitRules: [],
    error: "Invalid playground session",
  };
  if (!request) return { handled: false, result: emptyResult };
  const userId = (request.headers.get("x-opendum-playground-user-id") ?? "").trim();
  const timestampValue = (request.headers.get("x-opendum-playground-timestamp") ?? "").trim();
  const signature = (request.headers.get("x-opendum-playground-signature") ?? "").trim();
  if (!userId && !timestampValue && !signature) return { handled: false, result: emptyResult };
  if (!userId || !timestampValue || !signature || !secret.trim()) {
    return { handled: true, result: emptyResult };
  }
  const timestamp = Number.parseInt(timestampValue, 10);
  if (!Number.isFinite(timestamp)) return { handled: true, result: emptyResult };
  const requestTime = timestamp * 1000;
  const window = 2 * 60 * 1000;
  if (Date.now() - requestTime > window || requestTime - Date.now() > window) {
    return { handled: true, result: emptyResult };
  }
  let path: string;
  try {
    path = new URL(request.url).pathname;
  } catch {
    path = "/";
  }
  const expected = playgroundSignature(secret, userId, timestampValue, request.method, path);
  if (!signaturesMatch(expected, signature)) return { handled: true, result: emptyResult };
  return {
    handled: true,
    result: {
      valid: true,
      userId,
      apiKeyId: "",
      modelAccessMode: "all",
      modelAccessList: [],
      accountAccessMode: "all",
      accountAccessList: [],
      roamingEnabled: false,
      rateLimitRules: [],
      error: "",
    },
  };
}
