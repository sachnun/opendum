import { createHash } from "node:crypto";
import type Redis from "ioredis";
import { newID } from "../db/id.js";

const errorHistoryKeyPrefix = "opendum:provider-account:error-history";
const errorHistoryEntryKeyPrefix = "opendum:provider-account:error-history-entry";
const errorHistoryDedupeKeyPrefix = "opendum:provider-account:error-history-dedupe";
const errorHistoryDefaultTTL = 14 * 24 * 3600 * 1000;
const errorHistoryRateLimitTTL = 3 * 24 * 3600 * 1000;

interface RedisErrorHistoryEntry {
  id: string;
  providerAccountId: string;
  userId: string;
  model: string | null;
  errorCode: number;
  errorMessage: string;
  createdAt: string;
  dedupeKey: string;
}

function errorHistoryTTL(statusCode: number): number {
  return statusCode === 429 ? errorHistoryRateLimitTTL : errorHistoryDefaultTTL;
}

function errorHistoryKey(accountID: string): string {
  return `${errorHistoryKeyPrefix}:${accountID}`;
}

function errorHistoryEntryKey(entryID: string): string {
  return `${errorHistoryEntryKeyPrefix}:${entryID}`;
}

function errorHistoryDedupeKey(accountID: string, model: string | null, statusCode: number, message: string): string {
  const modelValue = model ?? "";
  const hash = sha256Hex([accountID, modelValue, String(statusCode), message].join("\x00"));
  return `${errorHistoryDedupeKeyPrefix}:${accountID}:${hash}`;
}

export async function upsertErrorHistory(
  redis: Redis | null,
  accountID: string,
  userID: string,
  model: string | null,
  statusCode: number,
  message: string,
  createdAt: Date,
): Promise<void> {
  if (!redis) return;

  const dedupeKey = errorHistoryDedupeKey(accountID, model, statusCode, message);
  let entryID = "";
  try {
    entryID = (await redis.get(dedupeKey)) ?? "";
  } catch {
    return;
  }
  if (entryID === "") {
    entryID = newID();
  }

  const entry: RedisErrorHistoryEntry = {
    id: entryID,
    providerAccountId: accountID,
    userId: userID,
    model,
    errorCode: statusCode,
    errorMessage: message,
    createdAt: createdAt.toISOString(),
    dedupeKey,
  };
  const ttl = errorHistoryTTL(statusCode);
  const score = createdAt.getTime();
  try {
    const pipe = redis.pipeline();
    pipe.set(errorHistoryEntryKey(entryID), JSON.stringify(entry), "PX", ttl);
    pipe.set(dedupeKey, entryID, "PX", ttl);
    pipe.zadd(errorHistoryKey(accountID), score, entryID);
    pipe.expire(errorHistoryKey(accountID), errorHistoryDefaultTTL / 1000);
    await pipe.exec();
  } catch {
    // ignore
  }
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
