import type { ChatCompletionRequest } from "./providers/types.js";

// Timeout for fetching individual image URLs (10 seconds)
const IMAGE_FETCH_TIMEOUT_MS = 10_000;

/**
 * Convert HTTP(S) image URLs in message content to base64 data URIs.
 *
 * Some providers (e.g. Ollama Cloud, Claude via Antigravity) do not
 * support image URLs — only base64-encoded data.  This function walks
 * through all messages, finds `image_url` content parts with HTTP(S)
 * URLs, fetches them, and replaces the URL with a base64 data URI.
 * Already-encoded data URIs are left untouched.
 *
 * If a fetch fails the original URL is kept so the provider returns
 * a clear error rather than silently dropping the image.
 */
export async function convertImageUrlsToBase64(
  messages: ChatCompletionRequest["messages"]
): Promise<ChatCompletionRequest["messages"]> {
  // Quick scan: bail early if there are no image_url parts with HTTP(S) URLs
  let hasHttpImageUrl = false;
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const part of msg.content as Array<{ type: string; [k: string]: unknown }>) {
      if (part.type !== "image_url") continue;
      const imageUrl = part.image_url as { url?: string } | undefined;
      if (imageUrl?.url && !imageUrl.url.startsWith("data:")) {
        hasHttpImageUrl = true;
        break;
      }
    }
    if (hasHttpImageUrl) break;
  }
  if (!hasHttpImageUrl) return messages;

  const result: ChatCompletionRequest["messages"] = [];

  for (const msg of messages) {
    if (!Array.isArray(msg.content)) {
      result.push(msg);
      continue;
    }

    const parts = msg.content as Array<{ type: string; [k: string]: unknown }>;
    const newParts: Array<{ type: string; [k: string]: unknown }> = [];

    for (const part of parts) {
      if (part.type !== "image_url") {
        newParts.push(part);
        continue;
      }

      const imageUrl = part.image_url as { url?: string; detail?: string } | undefined;
      if (!imageUrl?.url || imageUrl.url.startsWith("data:")) {
        newParts.push(part);
        continue;
      }

      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);
        const response = await fetch(imageUrl.url, { signal: controller.signal });
        clearTimeout(timer);

        if (!response.ok) {
          // Keep original URL — provider will surface an error
          newParts.push(part);
          continue;
        }

        const buffer = Buffer.from(await response.arrayBuffer());
        const contentType = response.headers.get("content-type") || "image/png";
        const base64 = buffer.toString("base64");
        const dataUri = `data:${contentType};base64,${base64}`;

        newParts.push({
          ...part,
          image_url: { ...imageUrl, url: dataUri },
        });
      } catch {
        // Fetch failed (timeout, network error, etc.) — keep original
        newParts.push(part);
      }
    }

    result.push({ ...msg, content: newParts });
  }

  return result;
}
