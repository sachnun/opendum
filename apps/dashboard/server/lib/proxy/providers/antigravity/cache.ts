// Thought signature cache for Antigravity
// Caches thought block signatures for multi-turn conversations

import { hashString } from "../../../encryption.js";
import { deleteRedisKey, getRedisJson, setRedisJson } from "../../../redis-cache.js";
import type { ModelFamily } from "./transform/types.js";

const SIGNATURE_CACHE_PREFIX = "opendum:thought-signature";
const SIGNATURE_CACHE_TTL_SECONDS = 60 * 60 * 24;

/**
 * Generates a cache key for a thought block.
 * Uses family + sessionId + thoughtText hash for uniqueness.
 */
function normalizeThoughtText(text: string): string {
  return text.trim();
}

function getSignatureCacheKey(
  family: ModelFamily,
  sessionId: string,
  thoughtText: string
): string {
  const normalizedText = normalizeThoughtText(thoughtText);
  return `${SIGNATURE_CACHE_PREFIX}:${hashString(`${family}:${sessionId}:${normalizedText}`)}`;
}

/**
 * Caches a thought signature for a given session and thought text.
 */
export async function cacheSignature(
  family: ModelFamily,
  sessionId: string,
  thoughtText: string,
  signature: string
) : Promise<void> {
  if (!sessionId || !thoughtText || !signature) return;

  await setRedisJson(
    getSignatureCacheKey(family, sessionId, thoughtText),
    { signature },
    SIGNATURE_CACHE_TTL_SECONDS
  );
}

/**
 * Gets cached signature for a thought.
 */
export async function getCachedSignature(
  family: ModelFamily,
  sessionId: string,
  thoughtText: string
) : Promise<string | null> {
  if (!sessionId || !thoughtText) return null;

  const cached = await getRedisJson<{ signature?: string }>(
    getSignatureCacheKey(family, sessionId, thoughtText)
  );
  return typeof cached?.signature === "string" ? cached.signature : null;
}

/**
 * Clears all cached signatures.
 */
export async function clearSignatureCache(
  family: ModelFamily,
  sessionId: string,
  thoughtText: string
): Promise<void> {
  await deleteRedisKey(getSignatureCacheKey(family, sessionId, thoughtText));
}
