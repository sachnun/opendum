import { Effect } from "effect";
import type { OpendumRedis } from "@opendum/core/redis";

const ERROR_HISTORY_KEY_PREFIX = "opendum:provider-account:error-history";
const ERROR_HISTORY_ENTRY_PREFIX = "opendum:provider-account:error-history-entry";
const ERROR_HISTORY_DEDUPE_PREFIX = "opendum:provider-account:error-history-dedupe";
const ERROR_HISTORY_DEFAULT_TTL_SECONDS = 14 * 24 * 60 * 60;
const ERROR_HISTORY_RATE_LIMIT_TTL_SECONDS = 3 * 24 * 60 * 60;

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

export function errorHistoryTtl(statusCode: number): number {
  return statusCode === 429 ? ERROR_HISTORY_RATE_LIMIT_TTL_SECONDS : ERROR_HISTORY_DEFAULT_TTL_SECONDS;
}

export function errorHistoryKey(accountId: string): string {
  return `${ERROR_HISTORY_KEY_PREFIX}:${accountId}`;
}

export function errorHistoryEntryKey(entryId: string): string {
  return `${ERROR_HISTORY_ENTRY_PREFIX}:${entryId}`;
}

export function errorHistoryDedupeKey(
  accountId: string,
  model: string | null,
  statusCode: number,
  message: string
): string {
  const hash = new Bun.CryptoHasher("sha256")
    .update([accountId, model ?? "", String(statusCode), message].join("\u0000"))
    .digest("hex");
  return `${ERROR_HISTORY_DEDUPE_PREFIX}:${accountId}:${hash}`;
}

export function upsertErrorHistory(
  redis: OpendumRedis | null,
  accountId: string,
  userId: string,
  model: string | null,
  statusCode: number,
  message: string,
  createdAt: Date
): Effect.Effect<void> {
  if (!redis) return Effect.void;
  const dedupeKey = errorHistoryDedupeKey(accountId, model, statusCode, message);
  const ttl = errorHistoryTtl(statusCode);
  return Effect.gen(function* () {
    const cachedEntryId = yield* redisEffect(() => redis.get(dedupeKey)).pipe(Effect.orElseSucceed(() => null));
    const entryId = cachedEntryId ? cachedEntryId : crypto.randomUUID();
    const entry: Entry = {
      id: entryId,
      providerAccountId: accountId,
      userId,
      model,
      errorCode: statusCode,
      errorMessage: message,
      createdAt: createdAt.toISOString(),
      dedupeKey,
    };
    yield* redisEffect(() => redis.set(errorHistoryEntryKey(entryId), JSON.stringify(entry), { EX: ttl }));
    yield* redisEffect(() => redis.set(dedupeKey, entryId, { EX: ttl }));
    yield* redisEffect(() => redis.zAdd(errorHistoryKey(accountId), { score: createdAt.getTime(), value: entryId }));
    yield* redisEffect(() => redis.expire(errorHistoryKey(accountId), ERROR_HISTORY_DEFAULT_TTL_SECONDS));
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
