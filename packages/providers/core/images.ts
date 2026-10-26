import { lookup } from "node:dns/promises";
import { Effect, Option } from "effect";
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

  static safe(value: string): Effect.Effect<boolean> {
    return Effect.gen(function* () {
      const parsed = yield* Effect.try({
        try: () => new URL(value),
        catch: () => null,
      }).pipe(Effect.option);
      if (Option.isNone(parsed)) return false;
      const target = parsed.value;
      if ((target.protocol !== "http:" && target.protocol !== "https:") || !target.hostname) return false;
      const addresses = yield* Effect.tryPromise({
        try: () => lookup(target.hostname, { all: true }),
        catch: () => null,
      }).pipe(Effect.option);
      if (Option.isNone(addresses)) return false;
      if (addresses.value.length === 0) return false;
      return addresses.value.every((entry) => !isPrivate(entry.address));
    });
  }
}

export class ImageDownloader {
  private readonly fetchFn: ImageFetch;

  constructor(fetchFn: ImageFetch) {
    this.fetchFn = fetchFn;
  }

  toDataUri(imageUrl: string): Effect.Effect<string> {
    const fetchFn = this.fetchFn;
    return Effect.gen(function* () {
      const safe = yield* ImageUrl.safe(imageUrl);
      if (!safe) return "";
      const resp = yield* Effect.tryPromise({
        try: () =>
          fetchFn(imageUrl, {
            method: "GET",
            headers: {
              "User-Agent": USER_AGENT,
              Accept: "image/*,application/pdf;q=0.9,*/*;q=0.8",
            },
            signal: AbortSignal.timeout(TIMEOUT_MS),
          }),
        catch: () => null,
      }).pipe(Effect.option);
      if (Option.isNone(resp)) return "";
      const response = resp.value;
      if (response.status < 200 || response.status >= 300) return "";
      const headerType = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
      if (headerType && !headerType.startsWith("image/") && headerType !== "application/pdf") return "";
      const body = yield* Effect.tryPromise({
        try: () => response.arrayBuffer(),
        catch: () => null,
      }).pipe(Effect.option);
      if (Option.isNone(body)) return "";
      const data = Buffer.from(body.value);
      if (data.byteLength > MAX_BYTES) return "";
      const contentType = response.headers.get("content-type") ?? "image/png";
      return `data:${contentType};base64,${data.toString("base64")}`;
    });
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

  run(messages: unknown[]): Effect.Effect<unknown[]> {
    const downloader = this.downloader;
    return Effect.gen(function* () {
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
            const dataUri = yield* downloader.toDataUri(url);
            if (dataUri) imageUrl.url = dataUri;
          }
          parts.push(copyPart);
        }
        copyMsg.content = parts;
        out.push(copyMsg);
      }
      return out;
    });
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

  run(input: unknown[]): Effect.Effect<unknown[]> {
    const downloader = this.downloader;
    return Effect.gen(function* () {
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
          const dataUri = yield* downloader.toDataUri(Value.string(part.image_url));
          if (dataUri) copyPart.image_url = dataUri;
          parts.push(copyPart);
        }
        copyItem.content = parts;
        out.push(copyItem);
      }
      return out;
    });
  }
}
