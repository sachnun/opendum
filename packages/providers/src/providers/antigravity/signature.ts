import { anySlice, type Json } from "#providers/providers/antigravity/config.ts";
import { stringValue } from "#providers/lib/helpers.ts";
import { signatureCacheKey } from "#providers/providers/antigravity/model-config.ts";
import { SIGNATURE_CACHE_TTL_SECONDS, type AntigravityRuntime } from "#providers/providers/antigravity/runtime.ts";

export async function getCachedSignature(
  rt: AntigravityRuntime,
  model: string,
  sessionId: string,
  thoughtText: string
): Promise<string> {
  if (!rt.redis || !sessionId || !thoughtText.trim()) return "";
  try {
    const raw = await rt.redis.get(signatureCacheKey(rt, model, sessionId, thoughtText));
    if (!raw) return "";
    const cached = JSON.parse(raw) as Json;
    return stringValue(cached.signature);
  } catch {
    return "";
  }
}

export async function cacheSignature(
  rt: AntigravityRuntime,
  model: string,
  sessionId: string,
  thoughtText: string,
  signature: string
): Promise<void> {
  if (!rt.redis || !sessionId || !thoughtText.trim() || !signature.trim()) return;
  try {
    await rt.redis.set(
      signatureCacheKey(rt, model, sessionId, thoughtText),
      JSON.stringify({ signature }),
      { EX: SIGNATURE_CACHE_TTL_SECONDS }
    );
  } catch {
    return;
  }
}

export async function cacheSignaturesFromResponse(
  rt: AntigravityRuntime,
  response: Json,
  model: string,
  sessionId: string
): Promise<void> {
  for (const candidate of anySlice(response.candidates)) {
    const content = ((candidate as Json).content ?? {}) as Json;
    for (const rawPart of anySlice(content.parts)) {
      const part = (rawPart ?? {}) as Json;
      if (part.thought === true) {
        const text = stringValue(part.text);
        const signature = stringValue(part.thoughtSignature);
        if (text && signature) await cacheSignature(rt, model, sessionId, text, signature);
      }
    }
  }
}
