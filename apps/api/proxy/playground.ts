import { emptyResult, type AuthResult } from "@opendum/auth/types";
import { playgroundSignature, signaturesMatch } from "@opendum/platform/crypto";

const WINDOW_MS = 2 * 60 * 1000;

export type Outcome = {
  handled: boolean;
  result: AuthResult;
};

export class Playground {
  constructor(private readonly secret: string) {}

  authenticate(request: Request | undefined): Outcome {
    const invalid = emptyResult("Invalid playground session");
    if (!request) return { handled: false, result: invalid };
    const userId = (request.headers.get("x-opendum-playground-user-id") ?? "").trim();
    const timestampValue = (request.headers.get("x-opendum-playground-timestamp") ?? "").trim();
    const signature = (request.headers.get("x-opendum-playground-signature") ?? "").trim();
    if (!userId && !timestampValue && !signature) return { handled: false, result: invalid };
    if (!userId || !timestampValue || !signature || !this.secret.trim()) {
      return { handled: true, result: invalid };
    }
    const timestamp = Number.parseInt(timestampValue, 10);
    if (!Number.isFinite(timestamp)) return { handled: true, result: invalid };
    const requestTime = timestamp * 1000;
    if (Date.now() - requestTime > WINDOW_MS || requestTime - Date.now() > WINDOW_MS) {
      return { handled: true, result: invalid };
    }
    const path = URL.canParse(request.url) ? new URL(request.url).pathname : "/";
    const expected = playgroundSignature(this.secret, userId, timestampValue, request.method, path);
    if (!signaturesMatch(expected, signature)) return { handled: true, result: invalid };
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
}
