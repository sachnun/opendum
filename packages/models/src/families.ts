/**
 * Model family inference.
 *
 * Maps a model key or data folder to a vendor family name. Shared by the
 * refresh scripts (to choose a folder) and the dashboard (to group models).
 */

export interface FamilyRule {
  test: RegExp;
  folder: string;
  family: string;
}

export const FAMILY_RULES: ReadonlyArray<FamilyRule> = [
  { test: /^claude-/, folder: "anthropic", family: "Anthropic" },
  { test: /^gpt($|-)|^chatgpt-|^o($|-)|^o\d/, folder: "openai", family: "OpenAI" },
  { test: /^gemini-?|^gemma|^diffusiongemma/, folder: "google", family: "Google" },
  { test: /^grok-?/, folder: "xai", family: "xAI" },
  { test: /^llama|^codellama/, folder: "meta", family: "Meta" },
  { test: /^phi-?/, folder: "microsoft", family: "Microsoft" },
  { test: /^qwen|^qwq-/, folder: "qwen", family: "Qwen" },
  { test: /^deepseek-?/, folder: "deepseek", family: "DeepSeek" },
  { test: /^kilo-auto-?/, folder: "kilo-code", family: "Kilo Code" },
  { test: /^kimi-?/, folder: "moonshot", family: "Moonshot" },
  { test: /^minimax-?/, folder: "minimax", family: "MiniMax" },
  { test: /^glm-?/, folder: "z-ai", family: "Z.AI" },
  { test: /^mistral-|^codestral|^devstral|^ministral|^mamba-codestral|^magistral|^mixtral/, folder: "mistral", family: "Mistral" },
  { test: /^nemotron-|^nim-?/, folder: "nvidia", family: "NVIDIA" },
  { test: /^openrouter-?/, folder: "openrouter", family: "OpenRouter" },
  { test: /^mimo-?/, folder: "xiaomi", family: "Xiaomi" },
  { test: /^hunyuan|^hy3/, folder: "hunyuan", family: "Hunyuan" },
  { test: /^ling-|^ring-/, folder: "inclusion-ai", family: "InclusionAI" },
  { test: /^mai-code/, folder: "microsoft", family: "Microsoft" },
  { test: /^nex-n/, folder: "nex-agi", family: "Nex AGI" },
  { test: /^north-/, folder: "cohere", family: "Cohere" },
  { test: /^granite/, folder: "ibm", family: "IBM" },
  { test: /^step-/, folder: "step-fun", family: "StepFun" },
  { test: /^laguna/, folder: "poolside", family: "Poolside" },
  { test: /^longcat/, folder: "meituan", family: "Meituan" },
  { test: /^inkling/, folder: "thinking-machines", family: "Thinking Machines" },
  { test: /^dots-?/, folder: "dots-studio", family: "Dots Studio" },
  { test: /^solar-/, folder: "upstage", family: "Upstage" },
  { test: /^agnes-/, folder: "sapiens-ai", family: "Sapiens AI" },
  { test: /^muse-spark/, folder: "meta", family: "Meta" },
];

const FAMILY_BY_FOLDER: Readonly<Record<string, string>> = Object.fromEntries(
  FAMILY_RULES.map((rule) => [rule.folder, rule.family]),
);

export function inferFamilyFromFolder(folderName: string | null | undefined): string | null {
  if (!folderName) return null;
  return FAMILY_BY_FOLDER[folderName] ?? null;
}

export function inferModelFolder(modelKey: string): string | null {
  const normalized = modelKey.toLowerCase();
  for (const rule of FAMILY_RULES) {
    if (rule.test.test(normalized)) return rule.folder;
  }
  return null;
}
