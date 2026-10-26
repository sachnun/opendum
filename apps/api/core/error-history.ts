import { Effect } from "effect";
import type { OpendumRedis } from "@opendum/core/redis";

const KEY_PREFIX = "opendum:provider-account:error-history";
const ENTRY_PREFIX = "opendum:provider-account:error-history-entry";
const DEDUPE_PREFIX = "opendum:provider-account:error-history-dedupe";
const DEFAULT_TTL = 14 * 24 * 60 * 60;
const RATE_LIMIT_TTL = 3 * 24 * 60 * 60;

type Entry = {
  id: string;
  providerAccountId: string;
  userId: string;
  model: string | null;
  errorCode: number;
  errorMessage: string;
  createdAt: string;
  dedupeKey: string;
};

export function historyTtl(statusCode: number): number {
  return statusCode === 429 ? RATE_LIMIT_TTL : DEFAULT_TTL;
}

export function historyKey(accountId: string): string {
  return `${KEY_PREFIX}:${accountId}`;
}

export function entryKey(entryId: string): string {
  return `${ENTRY_PREFIX}:${entryId}`;
}

export function dedupeKey(
  accountId: string,
  model: string | null,
  statusCode: number,
  message: string
): string {
  const hash = new Bun.CryptoHasher("sha256")
    .update([accountId, model ?? "", String(statusCode), message].join("\u0000"))
    .digest("hex");
  return `${DEDUPE_PREFIX}:${accountId}:${hash}`;
}

export function upsertHistory(
  redis: OpendumRedis | null,
  accountId: string,
  userId: string,
  model: string | null,
  statusCode: number,
  message: string,
  createdAt: Date
): Effect.Effect<void> {
  if (!redis) return Effect.void;
  const key = dedupeKey(accountId, model, statusCode, message);
  const ttl = historyTtl(statusCode);
  return Effect.gen(function* () {
    const cachedEntryId = yield* redisEffect(() => redis.get(key)).pipe(Effect.orElseSucceed(() => null));
    const entryId = cachedEntryId ? cachedEntryId : crypto.randomUUID();
    const entry: Entry = {
      id: entryId,
      providerAccountId: accountId,
      userId,
      model,
      errorCode: statusCode,
      errorMessage: message,
      createdAt: createdAt.toISOString(),
      dedupeKey: key,
    };
    yield* redisEffect(() => redis.set(entryKey(entryId), JSON.stringify(entry), { EX: ttl }));
    yield* redisEffect(() => redis.set(key, entryId, { EX: ttl }));
    yield* redisEffect(() => redis.zAdd(historyKey(accountId), { score: createdAt.getTime(), value: entryId }));
    yield* redisEffect(() => redis.expire(historyKey(accountId), DEFAULT_TTL));
  }).pipe(
    Effect.tapError((error) => Effect.logDebug("error history write failed", { accountId, error: error.message })),
    Effect.ignore
  );
}

function redisEffect<A>(run: () => Promise<A>): Effect.Effect<A, Error> {
  return Effect.tryPromise({
    try: run,
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  });
}
