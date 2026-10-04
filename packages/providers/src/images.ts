import { lookup } from "node:dns/promises";
import { isPrivateIp } from "@opendum/egress";
import { cloneAnyMap, stringValue } from "./helpers.js";

export type ImageFetch = (url: string, init?: RequestInit) => Promise<Response>;

const IMAGE_FETCH_TIMEOUT_MS = 30_000;
const MAX_IMAGE_FETCH_BYTES = 20 << 20;
const IMAGE_FETCH_USER_AGENT = "opendum-proxy/1.0 (+https://github.com/sachnun/opendum)";

function isExternalUrl(value: string): boolean {
  return (value.startsWith("http://") || value.startsWith("https://")) && !value.startsWith("data:");
}

async function isSafeExternalUrl(value: string): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname) return false;
  try {
    const addresses = await lookup(parsed.hostname, { all: true });
    if (addresses.length === 0) return false;
    return addresses.every((entry) => !isPrivateIp(entry.address));
  } catch {
    return false;
  }
}

async function fetchAsDataUri(fetchFn: ImageFetch, imageUrl: string): Promise<string> {
  if (!(await isSafeExternalUrl(imageUrl))) return "";
  let resp: Response;
  try {
    resp = await fetchFn(imageUrl, {
      method: "GET",
      headers: {
        "User-Agent": IMAGE_FETCH_USER_AGENT,
        Accept: "image/*,application/pdf;q=0.9,*/*;q=0.8",
      },
      signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS),
    });
  } catch {
    return "";
  }
  if (resp.status < 200 || resp.status >= 300) return "";
  const headerType = (resp.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (headerType && !headerType.startsWith("image/") && headerType !== "application/pdf") return "";

  const data = Buffer.from(await resp.arrayBuffer());
  if (data.byteLength > MAX_IMAGE_FETCH_BYTES) return "";
  const contentType = resp.headers.get("content-type") ?? "image/png";
  return `data:${contentType};base64,${data.toString("base64")}`;
}

function hasExternalChatImageUrl(messages: unknown[]): boolean {
  for (const raw of messages) {
    const msg = (raw ?? {}) as Record<string, unknown>;
    if (!Array.isArray(msg.content)) continue;
    for (const rawPart of msg.content) {
      const part = (rawPart ?? {}) as Record<string, unknown>;
      const imageUrl = (part.image_url ?? {}) as Record<string, unknown>;
      if (part.type === "image_url" && isExternalUrl(stringValue(imageUrl.url))) return true;
    }
  }
  return false;
}

function hasExternalResponsesImageUrl(input: unknown[]): boolean {
  for (const raw of input) {
    const item = (raw ?? {}) as Record<string, unknown>;
    if (!Array.isArray(item.content)) continue;
    for (const rawPart of item.content) {
      const part = (rawPart ?? {}) as Record<string, unknown>;
      if (part.type === "input_image" && isExternalUrl(stringValue(part.image_url))) return true;
    }
  }
  return false;
}

export async function convertImageURLsToBase64(
  fetchFn: ImageFetch,
  messages: unknown[]
): Promise<unknown[]> {
  if (!hasExternalChatImageUrl(messages)) return messages;
  const out: unknown[] = [];
  for (const raw of messages) {
    const msg = raw as Record<string, unknown>;
    const content = msg?.content;
    if (!msg || !Array.isArray(content)) {
      out.push(raw);
      continue;
    }
    const copyMsg = cloneAnyMap(msg);
    const parts: unknown[] = [];
    for (const rawPart of content) {
      const part = rawPart as Record<string, unknown>;
      if (!part || part.type !== "image_url") {
        parts.push(rawPart);
        continue;
      }
      const copyPart = cloneAnyMap(part);
      const imageUrl = (copyPart.image_url ?? {}) as Record<string, unknown>;
      const url = stringValue(imageUrl.url);
      if (isExternalUrl(url)) {
        const dataUri = await fetchAsDataUri(fetchFn, url);
        if (dataUri) imageUrl.url = dataUri;
      }
      parts.push(copyPart);
    }
    copyMsg.content = parts;
    out.push(copyMsg);
  }
  return out;
}

export async function convertResponsesInputImageURLsToBase64(
  fetchFn: ImageFetch,
  input: unknown[]
): Promise<unknown[]> {
  if (!hasExternalResponsesImageUrl(input)) return input;
  const out: unknown[] = [];
  for (const raw of input) {
    const item = raw as Record<string, unknown>;
    const content = item?.content;
    if (!item || !Array.isArray(content)) {
      out.push(raw);
      continue;
    }
    const copyItem = cloneAnyMap(item);
    const parts: unknown[] = [];
    for (const rawPart of content) {
      const part = rawPart as Record<string, unknown>;
      if (!part || part.type !== "input_image" || !isExternalUrl(stringValue(part.image_url))) {
        parts.push(rawPart);
        continue;
      }
      const copyPart = cloneAnyMap(part);
      const dataUri = await fetchAsDataUri(fetchFn, stringValue(part.image_url));
      if (dataUri) copyPart.image_url = dataUri;
      parts.push(copyPart);
    }
    copyItem.content = parts;
    out.push(copyItem);
  }
  return out;
}
