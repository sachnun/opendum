import type { Registry } from "../registry/index.js";

export function providerConfigBool(registry: Registry | null, model: string, provider: string, key: string): boolean {
  const value = providerConfigValue(registry, model, provider, key);
  return typeof value === "boolean" && value;
}

export function providerConfigString(registry: Registry | null, model: string, provider: string, key: string): string {
  const value = providerConfigValue(registry, model, provider, key);
  if (typeof value !== "string") return "";
  return value.trim();
}

export function providerConfigStringMap(registry: Registry | null, model: string, provider: string, key: string): Record<string, string> {
  const value = providerConfigValue(registry, model, provider, key);
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(value as Record<string, unknown>)) {
    if (typeof rawValue === "string" && rawValue.trim() !== "") {
      out[rawKey] = rawValue.trim();
    }
  }
  return out;
}

export function providerConfigIntMap(registry: Registry | null, model: string, provider: string, key: string): Record<string, number> {
  const value = providerConfigValue(registry, model, provider, key);
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const out: Record<string, number> = {};
  for (const [rawKey, rawValue] of Object.entries(value as Record<string, unknown>)) {
    const number = numberFromAny(rawValue);
    if (number !== 0) out[rawKey] = number;
  }
  return out;
}

export function providerConfigValue(registry: Registry | null, model: string, provider: string, key: string): unknown {
  if (!registry) return undefined;
  let cfg = registry.providerModelConfig(model, provider);
  if (!cfg && provider === "antigravity") {
    const normalized = normalizeAntigravityTieredModel(model);
    if (normalized !== model) {
      cfg = registry.providerModelConfig(normalized, provider);
    }
  }
  if (!cfg || !cfg.custom) return undefined;
  return cfg.custom[key];
}

export function normalizeAntigravityTieredModel(model: string): string {
  const normalized = model.trim().toLowerCase();
  for (const suffix of ["-minimal", "-low", "-medium", "-high"]) {
    if (normalized.endsWith(suffix)) {
      return normalized.slice(0, -suffix.length);
    }
  }
  return normalized;
}

function numberFromAny(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

/** SSE line scanner (mirrors proxy/sse.go). */
import { randomBytes, createHash } from "node:crypto";

export interface SSEEvent {
  data: string;
}

export class SSEScanner {
  private buffer = "";

  process(chunk: string, handle: (event: SSEEvent) => void): void {
    this.buffer += chunk.replace(/\r\n/g, "\n");
    const events = this.buffer.split("\n\n");
    this.buffer = events[events.length - 1];
    for (const event of events.slice(0, -1)) {
      processSSELines(event.split("\n"), handle);
    }
  }

  flush(handle: (event: SSEEvent) => void): void {
    if (this.buffer.trim() !== "") {
      processSSELines(this.buffer.split("\n"), handle);
    }
    this.buffer = "";
  }
}

export function processSSELines(lines: string[], handle: (event: SSEEvent) => void): void {
  const data: string[] = [];
  for (const line of lines) {
    if (line.startsWith("data:")) {
      data.push(line.slice(5).trim());
    }
  }
  if (data.length === 0) return;
  const payload = data.join("\n");
  if (payload !== "" && payload !== "[DONE]") {
    handle({ data: payload });
  }
}

/** Parse `data:` lines from raw SSE text into JSON events. */
export function parseSSEDataLines(text: string): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const data = trimmed.slice(5).trim();
    if (data === "" || data === "[DONE]") continue;
    try {
      events.push(JSON.parse(data) as Record<string, unknown>);
    } catch {
      // skip
    }
  }
  return events;
}

/** Random UUID v4. */
export function randomUUID(): string {
  const buf = randomBytes(16);
  buf[6] = (buf[6]! & 0x0f) | 0x40;
  buf[8] = (buf[8]! & 0x3f) | 0x80;
  const hex = buf.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function randomHyphenID(prefix: string): string {
  return prefix + "-" + randomUUID();
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
