import { hashString } from "@opendum/database";
import type { ModelFamily } from "./types.js";

const SIGNATURE_CACHE_PREFIX = "opendum:thought-signature";
const SIGNATURE_CACHE_TTL_SECONDS = 60 * 60 * 24;

export async function cacheSignature(
  _family: ModelFamily,
  _sessionId: string,
  _thoughtText: string,
  _signature: string
): Promise<void> {
  // Signature memory cache stub
}

export async function getCachedSignature(
  _family: ModelFamily,
  _sessionId: string,
  _thoughtText: string
): Promise<string | null> {
  return null;
}
