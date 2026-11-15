import { Effect } from "effect";
import { importJWK, jwtVerify, decodeProtectedHeader, type JWK, type JWTPayload } from "jose";

import { db, jwks } from "@opendum/database";
import { TtlCache } from "@opendum/api/web/lib/ttl-cache";

const CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_ALG = "EdDSA";

const ringCache = new TtlCache<KeyRing>(CACHE_TTL_MS);

type CachedKey = {
  alg: string;
  key: CryptoKey | Uint8Array;
};

type KeyRing = {
  keys: Map<string, CachedKey>;
  loadedAt: number;
};

function fresh(ring: KeyRing, now: number): boolean {
  return now - ring.loadedAt < CACHE_TTL_MS;
}

const readRing = Effect.fn("jwks.readRing")(function* () {
  const rows = yield* Effect.tryPromise({
    try: () =>
      db
        .select({ id: jwks.id, publicKey: jwks.publicKey, alg: jwks.alg })
        .from(jwks),
    catch: (cause) => cause,
  });

  const keys = new Map<string, CachedKey>();
  for (const row of rows) {
    const alg = row.alg ?? DEFAULT_ALG;
    const key = yield* Effect.tryPromise({
      try: () => importJWK(JSON.parse(row.publicKey) as JWK, alg),
      catch: (cause) => cause,
    });
    keys.set(row.id, { alg, key });
  }

  return { keys, loadedAt: Date.now() } satisfies KeyRing;
});

const keyRing = Effect.fn("jwks.keyRing")(function* () {
  const cached = ringCache.get("jwks");
  if (cached && fresh(cached, Date.now())) return cached;

  const next = yield* ringCache.load("jwks", () => Effect.runPromise(readRing()));
  return next;
});

export function invalidateJwks(): void {
  ringCache.invalidate();
}

const kidOf = Effect.fn("jwks.kidOf")(function* (token: string) {
  const header = yield* Effect.try({
    try: () => decodeProtectedHeader(token),
    catch: (cause) => cause,
  });

  return typeof header.kid === "string" && header.kid.length > 0 ? header.kid : null;
});

const verify = Effect.fn("jwks.verify")(function* (
  token: string,
  options: { issuer: string; audience: string }
) {
  const kid = yield* kidOf(token);
  if (!kid) return null;

  const current = yield* keyRing();
  const entry = current.keys.get(kid);
  if (!entry) {
    invalidateJwks();
    return null;
  }

  const payload = yield* Effect.tryPromise({
    try: () =>
      jwtVerify(token, entry.key, {
        issuer: options.issuer,
        audience: options.audience,
        algorithms: [entry.alg],
      }).then((result) => result.payload),
    catch: (cause) => cause,
  });

  return payload.sub && payload.aud ? payload : null;
});

export function verifyAccessToken(
  token: string,
  options: { issuer: string; audience: string }
): Promise<JWTPayload | null> {
  return Effect.runPromise(
    verify(token, options).pipe(
      Effect.catch(() => Effect.succeed(null)),
      Effect.map((payload) => payload ?? null)
    )
  );
}
