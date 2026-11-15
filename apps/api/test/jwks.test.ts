import { beforeEach, describe, expect, it, mock } from "bun:test";
import { SignJWT, exportJWK, generateKeyPair } from "jose";

process.env.BETTER_AUTH_SECRET ??= "test-secret";

type Row = { id: string; publicKey: string; alg: string | null };

const state: { rows: Row[] } = { rows: [] };

await mock.module("@opendum/database", () => ({
  db: {
    select: () => ({
      from: async () => state.rows,
    }),
  },
  jwks: { id: "id", publicKey: "publicKey", alg: "alg" },
}));

const { invalidateJwks, verifyAccessToken } = await import("@opendum/api/web/lib/jwks");

const options = { issuer: "opendum", audience: "opendum" };

beforeEach(() => {
  invalidateJwks();
  state.rows = [];
});

async function keyPair() {
  const { publicKey, privateKey } = await generateKeyPair("EdDSA", { crv: "Ed25519" });
  const jwk = await exportJWK(publicKey);
  return { privateKey, publicKey: JSON.stringify({ ...jwk, kty: "OKP", crv: "Ed25519" }) };
}

describe("access token verification", () => {
  it("verifies a token signed with a cached key", async () => {
    const pair = await keyPair();
    state.rows = [{ id: "key-1", publicKey: pair.publicKey, alg: "EdDSA" }];

    const token = await new SignJWT({ name: "Ada" })
      .setProtectedHeader({ alg: "EdDSA", kid: "key-1" })
      .setSubject("user-1")
      .setIssuer("opendum")
      .setAudience("opendum")
      .setExpirationTime("1h")
      .sign(pair.privateKey);

    const payload = await verifyAccessToken(token, options);

    expect(payload?.sub).toBe("user-1");
    expect(payload?.name).toBe("Ada");
  });

  it("rejects a token signed by a key outside the ring", async () => {
    const pair = await keyPair();
    const other = await keyPair();
    state.rows = [{ id: "key-1", publicKey: pair.publicKey, alg: "EdDSA" }];

    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "EdDSA", kid: "key-1" })
      .setSubject("user-1")
      .setIssuer("opendum")
      .setAudience("opendum")
      .setExpirationTime("1h")
      .sign(other.privateKey);

    expect(await verifyAccessToken(token, options)).toBeNull();
  });

  it("rejects a token with a mismatched audience", async () => {
    const pair = await keyPair();
    state.rows = [{ id: "key-1", publicKey: pair.publicKey, alg: "EdDSA" }];

    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "EdDSA", kid: "key-1" })
      .setSubject("user-1")
      .setIssuer("opendum")
      .setAudience("someone-else")
      .setExpirationTime("1h")
      .sign(pair.privateKey);

    expect(await verifyAccessToken(token, options)).toBeNull();
  });
});
