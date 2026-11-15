import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import type { Registry } from "@opendum/models/runtime";
import { CLINE_BASE_URL } from "@opendum/providers/auth/cline/constants";
import type { UpstreamTransport } from "@opendum/providers/http";
import type { ProviderAccount } from "@opendum/providers/types";
import { ClineProvider } from "@opendum/providers/upstreams/cline/index";

const account = { id: "acc-1" } as unknown as ProviderAccount;

type Captured = { url: string; init?: RequestInit };

function provider(response: { status?: number; body: string }, captured?: Captured[]): ClineProvider {
  const direct = async (url: string, init?: RequestInit): Promise<Response> => {
    captured?.push({ url, init });
    return new Response(response.body, { status: response.status ?? 200 });
  };
  const transport: UpstreamTransport = { direct, egress: null, egressReady: () => false };
  const registry = { upstream: (name: string) => name } as unknown as Registry;
  return new ClineProvider({ registry, transport });
}

async function refresh(cline: ClineProvider, refreshToken = "rt-1") {
  return Effect.runPromise(
    cline.refreshCredentials(refreshToken, account).pipe(
      Effect.map((credentials) => ({ ok: true as const, credentials })),
      Effect.catch((error) => Effect.succeed({ ok: false as const, error }))
    )
  );
}

describe("ClineProvider.refreshCredentials", () => {
  it("calls the refresh endpoint with the trimmed token and prefixes the access token", async () => {
    const captured: Captured[] = [];
    const fake = provider({ body: JSON.stringify({ data: { accessToken: "at-1", refreshToken: "rt-2" } }) }, captured);
    const before = Date.now();
    const result = await refresh(fake, "  rt-1  ");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.credentials.accessToken).toBe("workos:at-1");
      expect(result.credentials.refreshToken).toBe("rt-2");
      expect(result.credentials.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 60 * 60 * 1000);
    }
    expect(captured[0]?.url).toBe(`${CLINE_BASE_URL}/auth/refresh`);
    expect(captured[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(captured[0]?.init?.body))).toEqual({ refreshToken: "rt-1", grantType: "refresh_token" });
  });

  it("keeps the stored refresh token when the response omits one", async () => {
    const result = await refresh(provider({ body: JSON.stringify({ data: { accessToken: "at-1" } }) }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.credentials.refreshToken).toBe("rt-1");
  });

  it("fails with the provider label on non-2xx responses", async () => {
    const result = await refresh(provider({ status: 401, body: "expired" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.provider).toBe("cline");
      expect(result.error.message).toBe("cline token refresh failed: 401 expired");
    }
  });

  it("fails when the response carries no access token", async () => {
    const result = await refresh(provider({ body: JSON.stringify({ data: { accessToken: "  " } }) }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe("cline token refresh returned empty access token");
    }
  });
});
