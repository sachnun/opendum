// Thought signature cache for Antigravity
// Caches thought block signatures for multi-turn conversations

import type { ModelFamily } from "./transform/types";

interface CacheEntry {
  signature: string;
  timestamp: number;
}

// Cache structure: family -> sessionId -> thoughtText -> signature
const signatureCache = new Map<string, Map<string, Map<string, CacheEntry>>>();

// Cache TTL: 30 minutes
const CACHE_TTL_MS = 30 * 60 * 1000;

/**
 * Generate cache key from thought text
 * Uses first 100 chars + length to create a reasonably unique key
 */
function getTextKey(text: string): string {
  const prefix = text.slice(0, 100);
  return `${prefix}::${text.length}`;
}

/**
 * Cache a thought signature
 */
export function cacheSignature(
  family: ModelFamily,
  sessionId: string,
  thoughtText: string,
  signature: string
): void {
  if (!sessionId || !thoughtText || !signature) return;

  let familyCache = signatureCache.get(family);
  if (!familyCache) {
    familyCache = new Map();
    signatureCache.set(family, familyCache);
  }

  let sessionCache = familyCache.get(sessionId);
  if (!sessionCache) {
    sessionCache = new Map();
    familyCache.set(sessionId, sessionCache);
  }

  const textKey = getTextKey(thoughtText);
  sessionCache.set(textKey, {
    signature,
    timestamp: Date.now(),
  });
}

/**
 * Get cached signature for a thought
 */
export function getCachedSignature(
  family: ModelFamily,
  sessionId: string,
  thoughtText: string
): string | null {
  if (!sessionId || !thoughtText) return null;

  const familyCache = signatureCache.get(family);
  if (!familyCache) return null;

  const sessionCache = familyCache.get(sessionId);
  if (!sessionCache) return null;

  const textKey = getTextKey(thoughtText);
  const entry = sessionCache.get(textKey);

  if (!entry) return null;

  // Check TTL
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    sessionCache.delete(textKey);
    return null;
  }

  return entry.signature;
}

/**
 * Clear expired entries from cache
 */
export function cleanupCache(): void {
  const now = Date.now();

  for (const [family, familyCache] of signatureCache) {
    for (const [sessionId, sessionCache] of familyCache) {
      for (const [textKey, entry] of sessionCache) {
        if (now - entry.timestamp > CACHE_TTL_MS) {
          sessionCache.delete(textKey);
        }
      }

      if (sessionCache.size === 0) {
        familyCache.delete(sessionId);
      }
    }

    if (familyCache.size === 0) {
      signatureCache.delete(family);
    }
  }
}

// Run cleanup every 5 minutes
if (typeof setInterval !== "undefined") {
  setInterval(cleanupCache, 5 * 60 * 1000);
}
