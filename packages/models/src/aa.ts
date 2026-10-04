export interface AaEntry {
  slug: string;
  name: string;
  index: number;
  estimated: boolean;
}

export interface AaIndex {
  version: string;
  bySlug: Map<string, AaEntry>;
  byEffortlessSlug: Map<string, AaEntry>;
  byShape: Map<string, Map<string, AaEntry>>;
}

const EFFORT_SUFFIX = /-(?:xhigh|high|medium|low|minimal|adaptive|default|fallback)$/;
const INDEX_VERSION = /Intelligence Index v([0-9]+(?:\.[0-9]+)*)/;
const FLIGHT_CHUNK = /self\.__next_f\.push\(\[1,\s*"((?:[^"\\]|\\.)*)"\]\)/g;
const PARAM_TOKEN = /^(?:\d+(?:\.\d+)?[bmtk]|a\d+(?:\.\d+)?[bmtk]|\d+e|fp\d+|int\d+|q\d+|v\d+(?:\.\d+)*|\d{4,8})$/i;
const SIZE_TOKEN = /^(?:\d+(?:\.\d+)?[bmtk]|a\d+(?:\.\d+)?[bmtk]|\d+e)$/i;
const LAB_TOKENS: ReadonlySet<string> = new Set([
  "anthropic", "alibaba", "baidu", "bytedance", "cohere", "deepseek", "google",
  "ibm", "inclusionai", "meta", "microsoft", "minimax", "mistralai", "moonshotai",
  "nvidia", "openai", "poolside", "qwen", "sakana", "stepfun", "tencent",
  "thinkingmachines", "upstage", "xiaomi", "xai", "zhipuai",
]);

export function normalizeAaSlug(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/^[^/]*\//, "")
    .replace(/:(?:free|batch|thinking|online|extended|optimized|nitro|floor|latest)$/g, "")
    .replace(/[._]/g, "-")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function stripEffortSuffix(slug: string): string {
  let current = slug;
  for (;;) {
    const next = current.replace(EFFORT_SUFFIX, "");
    if (next === current) return current;
    current = next;
  }
}

export function canonicalShape(slug: string): string {
  const tokens = slug.split("-").filter(Boolean);
  const start = tokens.length > 1 && LAB_TOKENS.has(tokens[0]) ? 1 : 0;
  return tokens.slice(start).filter((token) => !PARAM_TOKEN.test(token)).sort().join("-");
}

export function sizeSignature(slug: string): string {
  return slug.split("-").filter((token) => SIZE_TOKEN.test(token)).sort().join("-");
}

function flightPayload(html: string): string {
  const chunks: string[] = [];
  FLIGHT_CHUNK.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FLIGHT_CHUNK.exec(html)) !== null) {
    try {
      chunks.push(JSON.parse(`"${match[1]}"`) as string);
    } catch {
      continue;
    }
  }
  return chunks.join("");
}

function balancedArray(text: string, from: number): string | null {
  const start = text.indexOf("[", from);
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "[" || char === "{") depth += 1;
    else if (char === "]" || char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function scoredModels(payload: string): Record<string, unknown>[] {
  const marker = '"models":[';
  let best: Record<string, unknown>[] = [];
  let cursor = 0;
  for (;;) {
    const at = payload.indexOf(marker, cursor);
    if (at === -1) break;
    cursor = at + 1;
    const raw = balancedArray(payload, at + marker.length - 1);
    if (!raw) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;
    const items = parsed.filter(
      (item): item is Record<string, unknown> =>
        item !== null && typeof item === "object" && typeof (item as Record<string, unknown>).intelligenceIndex === "number",
    );
    if (items.length > best.length) best = items;
  }
  return best;
}

export function parseLeaderboard(html: string): { version: string; models: AaEntry[] } {
  const models: AaEntry[] = [];
  for (const record of scoredModels(flightPayload(html))) {
    const slug = typeof record.slug === "string" ? record.slug.trim() : "";
    if (!slug) continue;
    models.push({
      slug,
      name: typeof record.name === "string" ? record.name : slug,
      index: record.intelligenceIndex as number,
      estimated: record.intelligenceIndexIsEstimated === true,
    });
  }
  const version = html.match(INDEX_VERSION)?.[1] ?? "";
  return { version, models };
}

export function buildAaIndex(models: readonly AaEntry[], version: string): AaIndex {
  const bySlug = new Map<string, AaEntry>();
  for (const model of models) {
    const key = normalizeAaSlug(model.slug);
    if (!key) continue;
    const existing = bySlug.get(key);
    if (!existing || model.index > existing.index) bySlug.set(key, model);
  }

  const byEffortlessSlug = new Map<string, AaEntry>();
  for (const entry of bySlug.values()) {
    const base = stripEffortSuffix(normalizeAaSlug(entry.slug));
    if (!bySlug.has(base)) continue;
    const existing = byEffortlessSlug.get(base);
    if (!existing || entry.index > existing.index) byEffortlessSlug.set(base, entry);
  }

  const byShape = new Map<string, Map<string, AaEntry>>();
  for (const entry of bySlug.values()) {
    const key = canonicalShape(normalizeAaSlug(entry.slug));
    if (!key) continue;
    const sizes = byShape.get(key) ?? new Map<string, AaEntry>();
    const size = sizeSignature(normalizeAaSlug(entry.slug));
    const existing = sizes.get(size);
    if (!existing || entry.index > existing.index) sizes.set(size, entry);
    byShape.set(key, sizes);
  }

  return { version, bySlug, byEffortlessSlug, byShape };
}

export function resolveAaScore(probes: Iterable<string | null | undefined>, index: AaIndex): AaEntry | null {
  const keys = new Set<string>();
  for (const probe of probes) {
    const key = normalizeAaSlug(probe);
    if (key) keys.add(key);
  }

  for (const key of keys) {
    const hit = index.bySlug.get(key);
    if (hit) return hit;
  }
  for (const key of keys) {
    const hit = index.byEffortlessSlug.get(stripEffortSuffix(key));
    if (hit) return hit;
  }

  for (const key of keys) {
    const sizes = index.byShape.get(canonicalShape(key));
    if (!sizes || sizes.size !== 1) continue;
    const [size, entry] = [...sizes.entries()][0];
    const probeSize = sizeSignature(key);
    if (probeSize && probeSize !== size) continue;
    return entry;
  }
  return null;
}
