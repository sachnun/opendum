import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
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

function isPrivateIP(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length === 4 && parts.every((p) => Number.isInteger(p) && p >= 0 && p <= 255)) {
    if (parts[0] === 10) return true;
    if (parts[0] === 127) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
  }
  return false;
}

/** Rejects loopback, private, link-local, multicast and unspecified addresses (SSRF guard). */
export async function isSafeExternalURL(value: string): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.hostname === "") return false;
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  const literal = isIP(hostname);
  if (literal !== 0) {
    if (literal === 4) return !isPrivateIP(hostname);
    return false; // IPv6 literals are not allowed (matches Go behavior)
  }
  try {
    const addresses = await lookup(hostname, { all: true });
    for (const entry of addresses) {
      if (entry.family === 4) {
        if (isPrivateIP(entry.address)) return false;
      } else {
        return false;
      }
    }
    return addresses.length > 0;
  } catch {
    return false;
  }
}

async function readAllBytes(body: ReadableStream<Uint8Array> | null): Promise<Uint8Array> {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.length;
      if (total > maxImageFetchBytes) break;
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

async function fetchAsDataURI(client: HttpClient, ctx: RequestContext, imageURL: string): Promise<string> {
  if (!(await isSafeExternalURL(imageURL))) return "";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), imageFetchTimeoutMs);
  try {
    const resp = await client.fetch(imageURL, { method: "GET", headers: {}, signal: controller.signal });
    if (resp.status < 200 || resp.status >= 300) return "";
    const contentType = (resp.headers["content-type"] ?? "").split(";")[0]!.toLowerCase().trim();
    if (contentType !== "" && !contentType.startsWith("image/") && contentType !== "application/pdf") return "";
    const bytes = await readAllBytes(resp.body);
    if (bytes.length > maxImageFetchBytes) return "";
    const finalContentType = resp.headers["content-type"] ?? "";
    const mime = finalContentType !== "" ? finalContentType : "image/png";
    return "data:" + mime + ";base64," + Buffer.from(bytes).toString("base64");
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}
