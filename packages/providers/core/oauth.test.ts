import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import type { ProviderAccount } from "../types.js";
import type { UpstreamTransport } from "./http.js";
import { OAuth, type Spec } from "./oauth.js";

const account = { id: "acc-1" } as unknown as ProviderAccount;

type Captured = { url: string; init?: RequestInit };

function transport(options: { status?: number; body?: string; captured?: Captured[] }): UpstreamTransport {
  return {
    direct: async (url, init) => {
      options.captured?.push({ url, init });
      return new Response(options.body ?? "{}", { status: options.status ?? 200 });
    },
    egress: null,
    egressReady: () => false,
  };
}

function spec(overrides: Partial<Spec> = {}): Spec {
  return {
    provider: "demo",
    tokenUrl: "https://demo.test/token",
    request: (refreshToken) => ({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken.trim() }),
    }),
    parse: (payload) => {
      const token = (payload as { access_token?: string }).access_token ?? "";
      if (!token) throw new Error("demo token refresh returned empty access token");
      return { accessToken: token, refreshToken: "next", expiresAt: new Date(0) };
    },
    transport: transport({}),
    ...overrides,
  };
}

async function attempt(exchange: OAuth, refreshToken = "rt") {
  return Effect.runPromise(
    exchange.exchange(refreshToken, account).pipe(
      Effect.map((credentials) => ({ ok: true as const, credentials })),
      Effect.catch((error) => Effect.succeed({ ok: false as const, error }))
    )
  );
}

describe("OAuth", () => {
  it("posts the refresh request and returns parsed credentials", async () => {
    const captured: Captured[] = [];
    const exchange = new OAuth(
      spec({ transport: transport({ body: JSON.stringify({ access_token: "at-1" }), captured }) })
    );
    const result = await attempt(exchange, "  rt-1  ");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.credentials.accessToken).toBe("at-1");
    expect(captured[0]?.url).toBe("https://demo.test/token");
    expect(captured[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(captured[0]?.init?.body))).toEqual({ refresh_token: "rt-1" });
  });

  it("turns non-2xx responses into credential failures with the provider label", async () => {
    const exchange = new OAuth(spec({ transport: transport({ status: 401, body: "denied" }) }));
    const result = await attempt(exchange);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error._tag).toBe("ProviderCredentialFailure");
      expect(result.error.provider).toBe("demo");
      expect(result.error.message).toBe("demo token refresh failed: 401 denied");
    }
  });

  it("wraps JSON decode errors in the failure channel", async () => {
    const exchange = new OAuth(spec({ transport: transport({ body: "<html>nope</html>" }) }));
    const result = await attempt(exchange);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.cause).toBeInstanceOf(SyntaxError);
  });

  it("awaits async parse hooks", async () => {
    const exchange = new OAuth(
      spec({
        transport: transport({ body: JSON.stringify({ access_token: "at-1" }) }),
        parse: async () => ({ accessToken: "async-at", refreshToken: "rt-2", expiresAt: new Date(123) }),
      })
    );
    const result = await attempt(exchange);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.credentials.accessToken).toBe("async-at");
      expect(result.credentials.refreshToken).toBe("rt-2");
    }
  });

  it("resolves the url and request asynchronously", async () => {
    const captured: Captured[] = [];
    const exchange = new OAuth(
      spec({
        tokenUrl: async () => "https://demo.test/slow-token",
        request: async (refreshToken) => ({ method: "POST", body: `body:${refreshToken}` }),
        transport: transport({ body: JSON.stringify({ access_token: "at-1" }), captured }),
      })
    );
    const result = await attempt(exchange);
    expect(result.ok).toBe(true);
    expect(captured[0]?.url).toBe("https://demo.test/slow-token");
    expect(captured[0]?.init?.body).toBe("body:rt");
  });

  it("propagates guard errors thrown by parse", async () => {
    const exchange = new OAuth(spec({ transport: transport({ body: JSON.stringify({}) }) }));
    const result = await attempt(exchange);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toBe("demo token refresh returned empty access token");
  });
});
