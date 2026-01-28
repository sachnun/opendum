// Thought signature cache for Antigravity
// Caches thought block signatures for multi-turn conversations

import type { ModelFamily } from "./transform/types";

const signatureCache = new Map<string, string>();

/**
 * Generates a cache key for a thought block.
 * Uses family + sessionId + thoughtText hash for uniqueness.
 */
function normalizeThoughtText(text: string): string {
  return text.trim();
}

function getSignatureKeySync(
  family: ModelFamily,
  sessionId: string,
  thoughtText: string
): string {
  // Synchronous version using simple hash for cache key
  const normalizedText = normalizeThoughtText(thoughtText);
  const input = `${family}:${sessionId}:${normalizedText}`;
  // Use first 100 chars + length as fallback for sync operations
  const prefix = input.slice(0, 100);
  return `${prefix}::${input.length}`;
}

/**
 * Caches a thought signature for a given session and thought text.
 */
export function cacheSignature(
  family: ModelFamily,
  sessionId: string,
  thoughtText: string,
  signature: string
): void {
  if (!sessionId || !thoughtText || !signature) return;

  const key = getSignatureKeySync(family, sessionId, thoughtText);
  signatureCache.set(key, signature);
}

/**
 * Gets cached signature for a thought.
 */
export function getCachedSignature(
  family: ModelFamily,
  sessionId: string,
  thoughtText: string
): string | null {
  if (!sessionId || !thoughtText) return null;

  const key = getSignatureKeySync(family, sessionId, thoughtText);
  return signatureCache.get(key) ?? null;
}

/**
 * Clears all cached signatures.
 */
export function clearSignatureCache(): void {
  signatureCache.clear();
}
