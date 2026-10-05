import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import type { OpendumRedis } from "@opendum/redis";

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
  const hash = createHash("sha256")
    .update([accountId, model ?? "", String(statusCode), message].join("\u0000"))
    .digest("hex");
  return `${ERROR_HISTORY_DEDUPE_PREFIX}:${accountId}:${hash}`;
}

export async function upsertErrorHistory(
  redis: OpendumRedis | null,
  accountId: string,
  userId: string,
  model: string | null,
  statusCode: number,
  message: string,
  createdAt: Date
): Promise<void> {
  if (!redis) return;
  const dedupeKey = errorHistoryDedupeKey(accountId, model, statusCode, message);
  let entryId: string | null;
  try {
    entryId = await redis.get(dedupeKey);
  } catch {
    entryId = null;
  }
  if (!entryId) entryId = randomUUID();
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
  const ttl = errorHistoryTtl(statusCode);
  try {
    await redis.set(errorHistoryEntryKey(entryId), JSON.stringify(entry), { EX: ttl });
    await redis.set(dedupeKey, entryId, { EX: ttl });
    await redis.zAdd(errorHistoryKey(accountId), {
      score: createdAt.getTime(),
      value: entryId,
    });
    await redis.expire(errorHistoryKey(accountId), ERROR_HISTORY_DEFAULT_TTL_SECONDS);
  } catch {
    return;
  }
}
