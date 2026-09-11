/**
 * Vendor (owner) resolution.
 *
 * The registry exposes `owner` as a short vendor slug (`anthropic`, `openai`,
 * `qwen`). External registries rarely expose a vendor directly: models.dev
 * reports a model *family* (`claude-opus`, `gpt-luna`) and LiteLLM reports the
 * hosting provider (`azure_ai`, `vertex_ai`). This module normalizes all of
 * those signals into a single vendor slug.
 */

/**
 * Family prefix -> vendor slug.
 *
 * Ordered longest-first so `claude-sonnet` wins over `claude`. Matching is
 * done on the normalized family string with a trailing `-` boundary.
 */
const FAMILY_VENDOR_MAP: ReadonlyArray<readonly [string, string]> = [
  ["claude", "anthropic"],
  ["gpt", "openai"],
  ["chatgpt", "openai"],
  ["o1", "openai"],
  ["o3", "openai"],
  ["o4", "openai"],
  ["gemini", "google"],
  ["gemma", "google"],
  ["diffusiongemma", "google"],
  ["llama", "meta"],
  ["codellama", "meta"],
  ["muse-spark", "meta"],
  ["mistral", "mistral"],
  ["magistral", "mistral"],
  ["codestral", "mistral"],
  ["devstral", "mistral"],
  ["ministral", "mistral"],
  ["mixtral", "mistral"],
  ["qwen", "qwen"],
  ["qwq", "qwen"],
  ["deepseek", "deepseek"],
  ["kimi", "moonshot"],
  ["minimax", "minimax"],
  ["glm", "z-ai"],
  ["nemotron", "nvidia"],
  ["nim", "nvidia"],
  ["granite", "ibm"],
  ["ling", "inclusion-ai"],
  ["ring", "inclusion-ai"],
  ["step", "stepfun"],
  ["hunyuan", "hunyuan"],
  ["hy", "hunyuan"],
  ["mimo", "xiaomi"],
  ["grok", "xai"],
  ["phi", "microsoft"],
  ["mai-code", "microsoft"],
  ["north", "cohere"],
  ["nex-n", "nex-agi"],
  ["laguna", "poolside"],
  ["longcat", "meituan"],
  ["inkling", "thinking-machines"],
  ["dots", "dots-studio"],
  ["solar", "upstage"],
  ["agnes", "sapiens-ai"],
  ["kilo-auto", "kilo-code"],
  ["openrouter", "openrouter"],
];

/**
 * Upstream namespace -> vendor slug.
 *
 * Only unambiguous namespaces are listed: several providers use internal
 * codenames (`lite`, `qmodel_latest`, `gm51model`) that are not vendors.
 */
export const UPSTREAM_VENDOR_MAP: Readonly<Record<string, string>> = {
  "@cf": "cloudflare",
  "z-ai": "z-ai",
  "deepseek-ai": "deepseek",
  "nex-agi": "nex-agi",
  alibaba: "qwen",
  cohere: "cohere",
  deepseek: "deepseek",
  "dots-studio": "dots-studio",
  google: "google",
  ibm: "ibm",
  inclusionai: "inclusion-ai",
  meta: "meta",
  minimax: "minimax",
  mistral: "mistral",
  mistralai: "mistral",
  moonshot: "moonshot",
  moonshotai: "moonshot",
  nvidia: "nvidia",
  openai: "openai",
  opencode: "opencode",
  openrouter: "openrouter",
  qwen: "qwen",
  stepfun: "stepfun",
  tencent: "hunyuan",
  upstage: "upstage",
  microsoft: "microsoft",
  xai: "xai",
};

/** models.dev provider id -> vendor slug. Used when a family is unavailable. */
export const PROVIDER_VENDOR_MAP: Readonly<Record<string, string>> = {
  anthropic: "anthropic",
  openai: "openai",
  google: "google",
  "google-vertex": "google",
  meta: "meta",
  mistral: "mistral",
  mistralai: "mistral",
  qwen: "qwen",
  alibaba: "qwen",
  "alibaba-cn": "qwen",
  deepseek: "deepseek",
  moonshot: "moonshot",
  minimax: "minimax",
  "z-ai": "z-ai",
  zai: "z-ai",
  nvidia: "nvidia",
  ibm: "ibm",
  cohere: "cohere",
  xai: "xai",
  microsoft: "microsoft",
  stepfun: "stepfun",
  upstage: "upstage",
  inclusionai: "inclusion-ai",
  tencent: "hunyuan",
  opencode: "opencode",
  pioneer: "mistral",
  nano: "google",
  moonshotai: "moonshot",
  "nex-agi": "nex-agi",
  "big-pickle": "opencode",
  hy: "hunyuan",
  hunyuan: "hunyuan",
  mimo: "xiaomi",
  granite: "ibm",
};

/**
 * Resolve a vendor slug from a models.dev `family` value.
 *
 * @example
 * vendorFromFamily("claude-opus") // "anthropic"
 * vendorFromFamily("gpt-luna")    // "openai"
 */
export function vendorFromFamily(family: string | null | undefined): string | null {
  if (!family) return null;
  const normalized = family.trim().toLowerCase().replace(/[_\s]+/g, "-");
  if (!normalized) return null;

  const withoutVersion = normalized.replace(/[\d.]+$/, "").replace(/-$/, "");
  for (const [prefix, vendor] of FAMILY_VENDOR_MAP) {
    if (normalized === prefix || normalized.startsWith(`${prefix}-`)) return vendor;
    if (withoutVersion && (withoutVersion === prefix || withoutVersion.startsWith(`${prefix}-`))) return vendor;
  }
  return null;
}

export function vendorFromUpstream(upstream: string | null | undefined): string | null {
  if (!upstream || !upstream.includes("/")) return null;
  const prefix = upstream.split("/")[0]?.trim().toLowerCase() ?? "";
  return UPSTREAM_VENDOR_MAP[prefix] ?? null;
}

export function vendorFromProviderId(providerId: string | null | undefined): string | null {
  if (!providerId) return null;
  return PROVIDER_VENDOR_MAP[providerId.trim().toLowerCase()] ?? null;
}
