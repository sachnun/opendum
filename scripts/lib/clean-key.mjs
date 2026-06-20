// Parameter-info stripping for model keys.
//
// Goal: derive a "clean" canonical-style key from a model basename by
// stripping parameter info (MoE compound size, single size, quantization,
// version, release date) and pure-behavior descriptor suffix tokens
// (`instruct`, `thinking`, `preview`, ...) whose semantics move into the
// `meta` block.
//
// Stripping tokens (left-to-right during a right-to-left trailing pass):
//   1. Drop `-Xb-aYb` MoE compound (both size and active collapse). Also
//      drops `-Xb-Ye` (`-128e` MoE expert-count) variants.
//   2. Drop standalone size tokens (`-Xb`/`-Xm`/`-Xt`).
//   3. Drop standalone quantization tokens anywhere (`-fp<N>`, `-int<N>`,
//      `-awq`, `-gptq`, `-gguf`, `-q<N>[_<letter>]`).
//   4. Drop trailing date tokens (`2512`, `2603`, `0905`, `202601`) when
//      no behavior descriptor follows them. Release versions (`v0.1`,
//      `v1.5`, `v2`, `v2.5`) are preserved as family identifiers.
//   5. Drop trailing behavior-descriptor tokens whose meaning is recorded
//      in `meta`: `instruct`, `it`, `chat`, `base`, `reasoning`,
//      `thinking`, `completion`, `preview`, `beta`, `alpha`,
//      `experimental`, `exp`, `deprecated`, `fast`, `nova`, `express`.
//
// Identifier/tier tokens preserved as family names:
//   * Family names (`claude`, `gemini`, `qwen`, `nemotron`, `mistral`, ...).
//   * Tier names (`ultra`, `super`, `pro`, `plus`, `nano`, `mini`,
//     `flash`, `lite`, `premium`, `mega`, `medium`, `small`, `xl`).
//   * Modality/discipline words (`coder`, `codex`, `code`, `vl`,
//     `vision`, `omni`, `multimodal`).
//
// Examples:
//   "nemotron-3-ultra-550b-a55b"             -> "nemotron-3-ultra"
//   "qwen3-coder-30b-a3b-instruct"           -> "qwen3-coder"
//   "qwen3-vl-30b-a3b-instruct"              -> "qwen3-vl"
//   "qwen3-vl-thinking"                      -> "qwen3-vl"
//   "mistral-large-3-675b-instruct-2512"     -> "mistral-large-3"
//   "claude-opus-4-6-thinking"               -> "claude-opus-4-6"
//   "nemotron-nano-vl"                       -> "nemotron-nano-vl"     (`vl` sub-family)
//   "llama-4-maverick-17b-128e-instruct"     -> "llama-4-maverick"
//   "mimo-v2.5"                              -> "mimo-v2.5"            (release version preserved)

const ACTIVE_PARAMS_SUFFIX = /^a[0-9]+(?:\.[0-9]+)?[kmbt]$/i;
const EXPERT_COUNT_SUFFIX = /^[0-9]+e$/i;
const SIZE_BM = /^[0-9]+(?:\.[0-9]+)?[bm]$/i;
const SIZE_T = /^[0-9]+(?:\.[0-9]+)?t$/i;
const QUANTIZATION = /^(?:fp[0-9]+|int[0-9]+|awq|gptq|gguf|q[0-9]+(?:_[a-z])?)$/i;
const VERSION = /^v[0-9]+(?:\.[0-9]+)*$/i;
const DATE_CANDIDATE = /^[0-9]{4,6}$/;

const BEHAVIOR_DESCRIPTOR =
  /^(?:instruct|it|chat|base|completion|reasoning|thinking|preview|beta|alpha|experimental|exp|deprecated)$/i;

const MODALITY_DESCRIPTOR = /^(?:coder|codex|code|vl|vision|omni|multimodal)$/i;

const DESCRIPTOR_TO_META = Object.freeze({
  reasoning: /^(?:thinking|reasoning)$/i,
  type: /^(?:instruct|it)$/i,
  status: /^(?:preview|beta|alpha|experimental|exp|deprecated)$/i,
  code: /^(?:coder|code|x?codex|code)$/i,
  variant: /^(?:vl|vision|omni|multimodal)$/i,
});

export const PARAMETER_INFO_PATTERNS = Object.freeze({
  ACTIVE_PARAMS_SUFFIX,
  EXPERT_COUNT_SUFFIX,
  SIZE_BM,
  SIZE_T,
  QUANTIZATION,
  VERSION,
  BEHAVIOR_DESCRIPTOR,
  MODALITY_DESCRIPTOR,
});

function isDateToken(token) {
  if (!DATE_CANDIDATE.test(token)) return false;
  const month = Number.parseInt(token.slice(-2), 10);
  return month >= 1 && month <= 12;
}

function isBehaviorDescriptor(token) {
  return BEHAVIOR_DESCRIPTOR.test(token);
}

function isPairableMoESuffix(token) {
  return ACTIVE_PARAMS_SUFFIX.test(token) || EXPERT_COUNT_SUFFIX.test(token);
}

/**
 * Strip every token that matches a parameter-info or pure-behavior
 * descriptor pattern. Identifier/tier tokens (`coder`, `vl`, `nano`,
 * `ultra`, release-version tokens like `v2.5`, ...) stay in the
 * basename as family names.
 */
export function stripParamInfoKey(modelKey) {
  if (typeof modelKey !== "string" || modelKey.length === 0) return modelKey;

  const tokens = modelKey.split(/[-_]/);

  let end = tokens.length;
  while (end > 0) {
    const t = tokens[end - 1];
    if (
      isPairableMoESuffix(t) ||
      SIZE_BM.test(t) ||
      SIZE_T.test(t) ||
      QUANTIZATION.test(t) ||
      isDateToken(t) ||
      isBehaviorDescriptor(t)
    ) {
      end -= 1;
      continue;
    }
    break;
  }

const kept = [];
for (let i = 0; i < end; i += 1) {
  const t = tokens[i];
  if (!t) continue;

  if (isPairableMoESuffix(t)) {
    const prev = kept.length > 0 ? kept[kept.length - 1] : null;
    if (prev && (SIZE_BM.test(prev) || SIZE_T.test(prev))) {
      kept.pop();
    }
    continue;
  }

  if (
    SIZE_BM.test(t) ||
    SIZE_T.test(t) ||
    QUANTIZATION.test(t) ||
    isBehaviorDescriptor(t)
  ) {
    continue;
  }

  kept.push(t);
}

  const cleaned = kept.filter(Boolean).join("-");
  return cleaned.length > 0 ? cleaned : modelKey;
}

/**
 * Extract meta field updates from descriptors present in a basename.
 * The migration layer uses this so even after the basename is stripped,
 * the semantic info is preserved.
 */
export function extractDescriptors(modelKey) {
  if (typeof modelKey !== "string" || modelKey.length === 0) return {};
  const tokens = modelKey.split(/[-_]/);
  const out = {};
  for (const token of tokens) {
    if (DESCRIPTOR_TO_META.reasoning.test(token)) {
      out.reasoning = true;
    } else if (DESCRIPTOR_TO_META.type.test(token)) {
      out.type = "instruct";
    } else if (DESCRIPTOR_TO_META.status.test(token)) {
      const normalized = token.toLowerCase();
      out.status = normalized === "exp" ? "experimental" : normalized;
    } else if (DESCRIPTOR_TO_META.code.test(token)) {
      out.code = true;
    } else if (DESCRIPTOR_TO_META.variant.test(token)) {
      const normalized = token.toLowerCase();
      out.variant =
        normalized === "vision"
          ? "vision"
          : normalized === "vl"
            ? "vl"
            : normalized === "omni"
              ? "omni"
              : "multimodal";
    }
  }
  return out;
}

/**
 * Generate kebab-fallback aliases for `provider/name` style upstream ids.
 */
export function aliasesFromUpstream(upstreamNames) {
  const aliases = new Set();
  if (!upstreamNames) return [];

  for (const name of upstreamNames) {
    if (typeof name !== "string" || name.length === 0) continue;
    if (name.includes("/")) {
      aliases.add(name.replace(/\//g, "-"));
    }
    aliases.add(name);
  }

  return [...aliases];
}

/**
 * Extract the dominant size magnitude from a basename (e.g. `70b`->70,
 * `550b-a55b`->550). Used to pick a winner during collision-merge.
 */
export function largestSizeValue(modelKey) {
  if (typeof modelKey !== "string" || modelKey.length === 0) return 0;
  let largest = 0;
  const matches = modelKey.match(/[0-9]+(?:\.[0-9]+)?[bm]/gi) || [];
  for (const match of matches) {
    const numeric = Number.parseFloat(match);
    if (Number.isFinite(numeric)) largest = Math.max(largest, numeric);
  }
  return largest;
}
