import type { ChatCompletionRequest } from "./providers/types.js";

// Timeout for fetching individual image URLs (10 seconds)
const IMAGE_FETCH_TIMEOUT_MS = 10_000;

/**
 * Fetch an HTTP(S) URL and return a base64 data URI.
 * Returns `null` on failure so callers can fall back to the original URL.
 */
async function fetchAsDataUri(url: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);

    if (!response.ok) return null;

    const buffer = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get("content-type") || "image/png";
    const base64 = buffer.toString("base64");
    return `data:${contentType};base64,${base64}`;
  } catch {
    return null;
  }
}

/** Returns true when a URL string is an external HTTP(S) URL (not already a data URI). */
function isExternalUrl(url: string | undefined): url is string {
  return typeof url === "string" && url.length > 0 && !url.startsWith("data:");
}

/**
 * Convert HTTP(S) image URLs in message content to base64 data URIs.
 *
 * Some providers (e.g. Ollama Cloud, Claude via Antigravity, GitHub Copilot)
 * do not support image URLs — only base64-encoded data.  This function walks
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
      if (isExternalUrl(imageUrl?.url)) {
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
      if (!isExternalUrl(imageUrl?.url)) {
        newParts.push(part);
        continue;
      }

      const dataUri = await fetchAsDataUri(imageUrl.url);
      if (dataUri) {
        newParts.push({
          ...part,
          image_url: { ...imageUrl, url: dataUri },
        });
      } else {
        // Fetch failed — keep original so the provider surfaces a clear error
        newParts.push(part);
      }
    }

    result.push({ ...msg, content: newParts });
  }

  return result;
}

/**
 * Convert HTTP(S) image URLs in Responses API input items to base64 data URIs.
 *
 * The Responses API uses `input_image` content blocks with a flat
 * `image_url` string (as opposed to Chat Completions' nested
 * `{ image_url: { url } }` format).  This function walks through all
 * input items, finds `input_image` parts with external HTTP(S) URLs,
 * fetches them, and replaces them with base64 data URIs.
 *
 * If a fetch fails the original URL is kept.
 */
export async function convertResponsesInputImageUrlsToBase64(
  input: Array<Record<string, unknown>>
): Promise<Array<Record<string, unknown>>> {
  // Quick scan: bail early if no input_image parts have external URLs
  let hasExternal = false;
  for (const item of input) {
    const content = item.content;
    if (!Array.isArray(content)) continue;
    for (const part of content as Array<Record<string, unknown>>) {
      if (part.type === "input_image" && isExternalUrl(part.image_url as string | undefined)) {
        hasExternal = true;
        break;
      }
    }
    if (hasExternal) break;
  }
  if (!hasExternal) return input;

  const result: Array<Record<string, unknown>> = [];

  for (const item of input) {
    const content = item.content;
    if (!Array.isArray(content)) {
      result.push(item);
      continue;
    }

    const parts = content as Array<Record<string, unknown>>;
    const newParts: Array<Record<string, unknown>> = [];

    for (const part of parts) {
      if (part.type !== "input_image" || !isExternalUrl(part.image_url as string | undefined)) {
        newParts.push(part);
        continue;
      }

      const dataUri = await fetchAsDataUri(part.image_url as string);
      if (dataUri) {
        newParts.push({ ...part, image_url: dataUri });
      } else {
        newParts.push(part);
      }
    }

    result.push({ ...item, content: newParts });
  }

  return result;
}
