import type { HttpClient, RequestContext } from "./types.js";
import { readAllText, stringValue } from "./http.js";

const imageFetchTimeoutMs = 30 * 1000;
const maxImageFetchBytes = 20 << 20;

export async function convertImageURLsToBase64(client: HttpClient, ctx: RequestContext, messages: unknown[]): Promise<unknown[]> {
  if (!hasExternalChatImageURL(messages)) return messages;
  const out: unknown[] = [];
  for (const raw of messages) {
    const msg = raw as Record<string, unknown>;
    const content = msg["content"];
    if (!Array.isArray(content)) {
      out.push(raw);
      continue;
    }
    const copyMsg = { ...msg };
    const parts: unknown[] = [];
    for (const rawPart of content) {
      const part = rawPart as Record<string, unknown>;
      if (part["type"] !== "image_url") {
        parts.push(rawPart);
        continue;
      }
      const copyPart = { ...part };
      const imageURL = (copyPart["image_url"] ?? {}) as Record<string, unknown>;
      const url = stringValue(imageURL["url"]);
      if (!isExternalURL(url)) {
        parts.push(copyPart);
        continue;
      }
      const dataURI = await fetchAsDataURI(client, ctx, url);
      if (dataURI !== "") {
        imageURL["url"] = dataURI;
      }
      parts.push(copyPart);
    }
    copyMsg["content"] = parts;
    out.push(copyMsg);
  }
  return out;
}

export async function convertResponsesInputImageURLsToBase64(client: HttpClient, ctx: RequestContext, input: unknown[]): Promise<unknown[]> {
  if (!hasExternalResponsesImageURL(input)) return input;
  const out: unknown[] = [];
  for (const raw of input) {
    const item = raw as Record<string, unknown>;
    const content = item["content"];
    if (!Array.isArray(content)) {
      out.push(raw);
      continue;
    }
    const copyItem = { ...item };
    const parts: unknown[] = [];
    for (const rawPart of content) {
      const part = rawPart as Record<string, unknown>;
      if (part["type"] !== "input_image" || !isExternalURL(stringValue(part["image_url"]))) {
        parts.push(rawPart);
        continue;
      }
      const copyPart = { ...part };
      const dataURI = await fetchAsDataURI(client, ctx, stringValue(part["image_url"]));
      if (dataURI !== "") {
        copyPart["image_url"] = dataURI;
      }
      parts.push(copyPart);
    }
    copyItem["content"] = parts;
    out.push(copyItem);
  }
  return out;
}

function hasExternalChatImageURL(messages: unknown[]): boolean {
  for (const raw of messages) {
    const msg = raw as Record<string, unknown>;
    const content = msg["content"];
    if (!Array.isArray(content)) continue;
    for (const rawPart of content) {
      const part = rawPart as Record<string, unknown>;
      const imageURL = (part["image_url"] ?? {}) as Record<string, unknown>;
      if (part["type"] === "image_url" && isExternalURL(stringValue(imageURL["url"]))) return true;
    }
  }
  return false;
}

function hasExternalResponsesImageURL(input: unknown[]): boolean {
  for (const raw of input) {
    const item = raw as Record<string, unknown>;
    const content = item["content"];
    if (!Array.isArray(content)) continue;
    for (const rawPart of content) {
      const part = rawPart as Record<string, unknown>;
      if (part["type"] === "input_image" && isExternalURL(stringValue(part["image_url"]))) return true;
    }
  }
  return false;
}

export function isExternalURL(value: string): boolean {
  return (value.startsWith("http://") || value.startsWith("https://")) && !value.startsWith("data:");
}

function isSafeExternalURL(value: string): boolean {
  try {
    const parsed = new URL(value);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.hostname === "") return false;
    return true;
  } catch {
    return false;
  }
}

async function fetchAsDataURI(client: HttpClient, ctx: RequestContext, imageURL: string): Promise<string> {
  if (!isSafeExternalURL(imageURL)) return "";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), imageFetchTimeoutMs);
  try {
    const resp = await client.fetch(imageURL, { method: "GET", headers: {}, signal: controller.signal });
    if (resp.status < 200 || resp.status >= 300) return "";
    const contentType = (resp.headers["content-type"] ?? "").split(";")[0]!.toLowerCase().trim();
    if (contentType !== "" && !contentType.startsWith("image/") && contentType !== "application/pdf") return "";
    const text = await readAllText(resp.body);
    if (text.length > maxImageFetchBytes) return "";
    const finalContentType = resp.headers["content-type"] ?? "";
    const mime = finalContentType !== "" ? finalContentType : "image/png";
    return "data:" + mime + ";base64," + Buffer.from(text, "utf8").toString("base64");
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}
