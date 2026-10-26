import { lookup } from "node:dns/promises";
import { isPrivate } from "@opendum/core/egress";
import { Value, Payload } from "@opendum/providers/core/helpers";

export type ImageFetch = (url: string, init?: RequestInit) => Promise<Response>;

const TIMEOUT_MS = 30_000;
const MAX_BYTES = 20 << 20;
const USER_AGENT = "opendum-proxy/1.0 (+https://github.com/sachnun/opendum)";

const isRemote = (value: string): boolean =>
  (value.startsWith("http://") || value.startsWith("https://")) && !value.startsWith("data:");

export class ImageUrl {
  static remote(value: string): boolean {
    return isRemote(value);
  }

  static async safe(value: string): Promise<boolean> {
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
      return addresses.every((entry) => !isPrivate(entry.address));
    } catch {
      return false;
    }
  }
}

export class ImageDownloader {
  private readonly fetchFn: ImageFetch;

  constructor(fetchFn: ImageFetch) {
    this.fetchFn = fetchFn;
  }

  async toDataUri(imageUrl: string): Promise<string> {
    if (!(await ImageUrl.safe(imageUrl))) return "";

    let resp: Response;
    try {
      resp = await this.fetchFn(imageUrl, {
        method: "GET",
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "image/*,application/pdf;q=0.9,*/*;q=0.8",
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      return "";
    }
    if (resp.status < 200 || resp.status >= 300) return "";

    const headerType = (resp.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (headerType && !headerType.startsWith("image/") && headerType !== "application/pdf") return "";

    const data = Buffer.from(await resp.arrayBuffer());
    if (data.byteLength > MAX_BYTES) return "";

    const contentType = resp.headers.get("content-type") ?? "image/png";
    return `data:${contentType};base64,${data.toString("base64")}`;
  }
}

export class ChatImageInliner {
  private readonly downloader: ImageDownloader;

  constructor(fetchFn: ImageFetch) {
    this.downloader = new ImageDownloader(fetchFn);
  }

  private static hasRemoteChat(messages: unknown[]): boolean {
    for (const raw of messages) {
      const msg = (raw ?? {}) as Record<string, unknown>;
      if (!Array.isArray(msg.content)) continue;
      for (const rawPart of msg.content) {
        const part = (rawPart ?? {}) as Record<string, unknown>;
        const imageUrl = (part.image_url ?? {}) as Record<string, unknown>;
        if (part.type === "image_url" && ImageUrl.remote(Value.string(imageUrl.url))) return true;
      }
    }
    return false;
  }

  async run(messages: unknown[]): Promise<unknown[]> {
    if (!ChatImageInliner.hasRemoteChat(messages)) return messages;

    const out: unknown[] = [];
    for (const raw of messages) {
      const msg = raw as Record<string, unknown>;
      const content = msg?.content;
      if (!msg || !Array.isArray(content)) {
        out.push(raw);
        continue;
      }

      const copyMsg = Payload.clone(msg);
      const parts: unknown[] = [];
      for (const rawPart of content) {
        const part = rawPart as Record<string, unknown>;
        if (!part || part.type !== "image_url") {
          parts.push(rawPart);
          continue;
        }

        const copyPart = Payload.clone(part);
        const imageUrl = (copyPart.image_url ?? {}) as Record<string, unknown>;
        const url = Value.string(imageUrl.url);
        if (ImageUrl.remote(url)) {
          const dataUri = await this.downloader.toDataUri(url);
          if (dataUri) imageUrl.url = dataUri;
        }
        parts.push(copyPart);
      }
      copyMsg.content = parts;
      out.push(copyMsg);
    }
    return out;
  }
}

export class ResponsesImageInliner {
  private readonly downloader: ImageDownloader;

  constructor(fetchFn: ImageFetch) {
    this.downloader = new ImageDownloader(fetchFn);
  }

  private static hasRemoteResponses(input: unknown[]): boolean {
    for (const raw of input) {
      const item = (raw ?? {}) as Record<string, unknown>;
      if (!Array.isArray(item.content)) continue;
      for (const rawPart of item.content) {
        const part = (rawPart ?? {}) as Record<string, unknown>;
        if (part.type === "input_image" && ImageUrl.remote(Value.string(part.image_url))) return true;
      }
    }
    return false;
  }

  async run(input: unknown[]): Promise<unknown[]> {
    if (!ResponsesImageInliner.hasRemoteResponses(input)) return input;

    const out: unknown[] = [];
    for (const raw of input) {
      const item = raw as Record<string, unknown>;
      const content = item?.content;
      if (!item || !Array.isArray(content)) {
        out.push(raw);
        continue;
      }

      const copyItem = Payload.clone(item);
      const parts: unknown[] = [];
      for (const rawPart of content) {
        const part = rawPart as Record<string, unknown>;
        if (!part || part.type !== "input_image" || !ImageUrl.remote(Value.string(part.image_url))) {
          parts.push(rawPart);
          continue;
        }

        const copyPart = Payload.clone(part);
        const dataUri = await this.downloader.toDataUri(Value.string(part.image_url));
        if (dataUri) copyPart.image_url = dataUri;
        parts.push(copyPart);
      }
      copyItem.content = parts;
      out.push(copyItem);
    }
    return out;
  }
}
