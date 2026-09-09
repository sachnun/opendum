import { hashString } from "@opendum/database";
import type { ModelFamily } from "./types.js";

const SIGNATURE_CACHE_PREFIX = "opendum:thought-signature";
const SIGNATURE_CACHE_TTL_MS = 60 * 60 * 24 * 1000;

interface CacheEntry {
    signature: string;
    expiresAt: number;
}

const memoryCache = new Map<string, CacheEntry>();

function getSignatureKey(
    family: ModelFamily,
    sessionId: string,
    thoughtText: string,
): string {
    const normalized = thoughtText.trim();
    const hash = hashString(`${family}:${sessionId}:${normalized}`);
    return `${SIGNATURE_CACHE_PREFIX}:${hash}`;
}

export function cacheSignatureSync(
    family: ModelFamily,
    sessionId: string,
    thoughtText: string,
    signature: string,
): void {
    if (!sessionId || !thoughtText.trim() || !signature.trim()) return;

    const key = getSignatureKey(family, sessionId, thoughtText);
    memoryCache.set(key, {
        signature: signature.trim(),
        expiresAt: Date.now() + SIGNATURE_CACHE_TTL_MS,
    });

    if (memoryCache.size > 2000) {
        const now = Date.now();
        for (const [k, v] of memoryCache.entries()) {
            if (v.expiresAt <= now) memoryCache.delete(k);
        }
    }
}

export async function cacheSignature(
    family: ModelFamily,
    sessionId: string,
    thoughtText: string,
    signature: string,
): Promise<void> {
    cacheSignatureSync(family, sessionId, thoughtText, signature);
}

export function getCachedSignatureSync(
    family: ModelFamily,
    sessionId: string,
    thoughtText: string,
): string | null {
    if (!sessionId || !thoughtText.trim()) return null;

    const key = getSignatureKey(family, sessionId, thoughtText);
    const entry = memoryCache.get(key);
    if (!entry) return null;

    if (entry.expiresAt <= Date.now()) {
        memoryCache.delete(key);
        return null;
    }

    return entry.signature;
}

export async function getCachedSignature(
    family: ModelFamily,
    sessionId: string,
    thoughtText: string,
): Promise<string | null> {
    return getCachedSignatureSync(family, sessionId, thoughtText);
}
