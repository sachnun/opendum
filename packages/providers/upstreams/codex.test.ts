import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import type { Registry } from "@opendum/models/runtime";
import { CODEX_CLIENT_ID, CODEX_TOKEN_ENDPOINT } from "../endpoints.js";
import type { UpstreamTransport } from "../core/http.js";
import type { ProviderAccount } from "../types.js";
import { CodexProvider } from "./codex.js";

const account = { id: "acc-1" } as unknown as ProviderAccount;

type Captured = { url: string; init?: RequestInit };

function jwt(claims: Record<string, unknown>): string {
  return `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y`;
}

function provider(response: { status?: number; body: string }, captured?: Captured[]): CodexProvider {
  const direct = async (url: string, init?: RequestInit): Promise<Response> => {
    captured?.push({ url, init });
    return new Response(response.body, { status: response.status ?? 200 });
  };
  const transport: UpstreamTransport = { direct, egress: null, egressReady: () => false };
  const registry = { upstreamModelName: (name: string) => name } as unknown as Registry;
  return new CodexProvider({ registry, transport });
}

async function refresh(codex: CodexProvider, refreshToken = "rt-1") {
  return Effect.runPromise(
    codex.refreshCredentials(refreshToken, account).pipe(
      Effect.map((credentials) => ({ ok: true as const, credentials })),
      Effect.catch((error) => Effect.succeed({ ok: false as const, error }))
    )
  );
}

describe("CodexProvider.refreshCredentials", () => {
  it("posts the form body and reads tier and account from the JWTs", async () => {
    const captured: Captured[] = [];
    const accessToken = jwt({ chatgpt_account_id: "acc-1" });
    const idToken = jwt({ chatgpt_plan_type: "Plus" });
    const fake = provider(
      { body: JSON.stringify({ access_token: accessToken, refresh_token: "rt-2", expires_in: 1800, id_token: idToken }) },
      captured
    );
    const before = Date.now();
    const result = await refresh(fake, "  rt-1  ");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.credentials.accessToken).toBe(accessToken);
      expect(result.credentials.refreshToken).toBe("rt-2");
      expect(result.credentials.accountId).toBe("acc-1");
      expect(result.credentials.tier).toBe("plus");
      expect(result.credentials.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 1800 * 1000);
    }
    expect(captured[0]?.url).toBe(CODEX_TOKEN_ENDPOINT);
    const headers = captured[0]?.init?.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    const form = new URLSearchParams(String(captured[0]?.init?.body));
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe("rt-1");
    expect(form.get("client_id")).toBe(CODEX_CLIENT_ID);
  });

  it("falls back to the id token for the account id and defaults the expiry", async () => {
    const before = Date.now();
    const result = await refresh(
      provider({ body: JSON.stringify({ access_token: jwt({}), id_token: jwt({ chatgpt_account_id: "acc-9" }) }) }),
      "rt-1"
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.credentials.accountId).toBe("acc-9");
      expect(result.credentials.refreshToken).toBe("rt-1");
      expect(result.credentials.tier).toBe("");
      expect(result.credentials.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 3600 * 1000);
    }
  });

  it("reads the tier from the access token when no id token is present", async () => {
    const result = await refresh(provider({ body: JSON.stringify({ access_token: jwt({ chatgpt_plan_type: "Pro" }) }) }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.credentials.tier).toBe("pro");
  });

  it("fails with the provider label on non-2xx responses", async () => {
    const result = await refresh(provider({ status: 429, body: "busy" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.provider).toBe("codex");
      expect(result.error.message).toBe("codex token refresh failed: 429 busy");
    }
  });

  it("rejects empty access tokens", async () => {
    const result = await refresh(provider({ body: JSON.stringify({ access_token: "" }) }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toBe("codex token refresh returned empty access token");
  });
});
