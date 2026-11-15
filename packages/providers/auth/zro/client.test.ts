import { describe, expect, it } from "bun:test";
import { Effect } from "effect";

import { zroAuth, decryptDeviceToken, generateDeviceKey } from "@opendum/providers/auth/zro/client";
import { isFailed, isPending } from "@opendum/providers/auth/response";
import type { AuthRuntime } from "@opendum/providers/auth/runtime";

type Captured = { url: string; body: unknown };

function runtime(
  handler: (url: string, body: unknown) => Response,
  captured: Captured[] = []
): AuthRuntime {
  return {
    fetch: (url: string, init?: { body?: BodyInit | Record<string, unknown> | null }) => {
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
      captured.push({ url, body });
      return Effect.succeed(handler(url, body));
    },
    unavailable: (message: string) => new Error(message),
    badRequest: (message: string) => new Error(message),
    store: {} as never,
    hash: (text: string) => Bun.hash(text).toString(16),
    saveAccountId: () => Effect.void,
  } as unknown as AuthRuntime;
}

async function encryptFor(publicKeyPem: string, plain: string): Promise<string> {
  const der = Uint8Array.from(atob(publicKeyPem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "")), (char) =>
    char.charCodeAt(0)
  );
  const key = await crypto.subtle.importKey("spki", der, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]);
  const sealed = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, key, new TextEncoder().encode(plain));
  return btoa(String.fromCharCode(...new Uint8Array(sealed)));
}

describe("zro device flow", () => {
  it("posts a PEM public key and returns the device session", async () => {
    const captured: Captured[] = [];
    const auth = zroAuth(
      runtime(
        () =>
          Response.json({
            deviceCode: "device-1",
            userCode: "ABCD-1234",
            verificationUri: "https://zro.moonmath.ai/cli/authorize",
            verificationUriComplete: "https://zro.moonmath.ai/cli/authorize?code=ABCD-1234",
            expiresIn: 600,
            interval: 2,
          }),
        captured
      )
    );

    const started = await Effect.runPromise(auth.startDeviceFlow());
    expect(captured[0]?.url).toBe("https://zro.moonmath.ai/api/cli/auth/start");
    const body = captured[0]?.body as { publicKey: string; deviceName: string };
    expect(body.publicKey.startsWith("-----BEGIN PUBLIC KEY-----")).toBe(true);
    expect(body.deviceName).toBeTruthy();
    expect(started.deviceCode).toBe("device-1");
    expect(started.userCode).toBe("ABCD-1234");
    expect(started.verificationUrlComplete).toContain("code=ABCD-1234");
    expect(started.codeVerifier.startsWith("-----BEGIN PRIVATE KEY-----")).toBe(true);
  });

  it("treats 202 as pending and decrypts the credential once approved", async () => {
    const captured: Captured[] = [];
    const pendingAuth = zroAuth(
      runtime(
        () =>
          Response.json({
            deviceCode: "device-1",
            userCode: "ABCD-1234",
            verificationUri: "https://zro.moonmath.ai/cli/authorize",
          }),
        captured
      )
    );
    const started = await Effect.runPromise(pendingAuth.startDeviceFlow());
    const publicKey = (captured.at(0)?.body as { publicKey?: string } | undefined)?.publicKey ?? "";
    expect(publicKey.startsWith("-----BEGIN PUBLIC KEY-----")).toBe(true);

    const pending = await Effect.runPromise(
      zroAuth(runtime(() => new Response(JSON.stringify({ status: "pending" }), { status: 202 }))).pollDeviceAuth(
        started.deviceCode,
        started.userCode,
        started.codeVerifier
      )
    );
    expect(isPending(pending)).toBe(true);

    const sealed = await encryptFor(publicKey, "sk-zro-approved");
    const approved = await Effect.runPromise(
      zroAuth(runtime(() => Response.json({ encryptedToken: sealed }))).pollDeviceAuth(
        started.deviceCode,
        started.userCode,
        started.codeVerifier
      )
    );
    expect(isFailed(approved)).toBe(false);
    if (!isPending(approved) && !isFailed(approved)) {
      expect(approved.accessToken).toBe("sk-zro-approved");
      expect(approved.refreshToken).toBe("sk-zro-approved");
      expect(approved.email.startsWith("zro-")).toBe(true);
    }
  });

  it("decrypts a token sealed with the matching public key", async () => {
    const key = await Effect.runPromise(generateDeviceKey());
    const sealed = await encryptFor(key.publicKey, "sk-zro-test");
    const plain = await Effect.runPromise(decryptDeviceToken(key.privateKey, sealed));
    expect(plain).toBe("sk-zro-test");
  });

  it("fails when the credential cannot be decrypted", async () => {
    const auth = zroAuth(
      runtime(() => Response.json({ encryptedToken: "bm90LWEtcmVhbC10b2tlbg==" }))
    );
    const result = await Effect.runPromise(auth.pollDeviceAuth("device-1", "ABCD-1234", "not-a-key"));
    expect(isFailed(result)).toBe(true);
  });

  it("reports an expired device code as a failure", async () => {
    const auth = zroAuth(
      runtime(() => new Response(JSON.stringify({ error: "expired" }), { status: 410 }))
    );
    const result = await Effect.runPromise(auth.pollDeviceAuth("device-1", "ABCD-1234", "key"));
    expect(isFailed(result)).toBe(true);
    if (isFailed(result)) expect(result.error).toContain("expired");
  });
});
