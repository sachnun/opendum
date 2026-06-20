import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(scriptDir, "..");
const modelsDir = resolve(rootDir, "models");

// ---------------------------------------------------------------------------
// Family slug mapping
// ---------------------------------------------------------------------------

const FAMILY_BY_SLUG = {
  "abacus-ai": "Abacus.AI",
  "agi-nova": "AGI Nova",
  ai21: "AI21",
  "ai-singapore": "AI Singapore",
  anthropic: "Anthropic",
  baichuan: "Baichuan",
  baidu: "Baidu",
  bielik: "Bielik",
  "byte-dance": "ByteDance",
  "cognitive-computations": "Cognitive Computations",
  "core-think": "CoreThink",
  databricks: "Databricks",
  deepseek: "DeepSeek",
  "euro-llm": "EuroLLM",
  google: "Google",
  hunyuan: "Hunyuan",
  ibm: "IBM",
  "inclusion-ai": "InclusionAI",
  "kilo-code": "Kilo Code",
  "liquid-ai": "Liquid AI",
  marin: "Marin",
  "media-tek": "MediaTek",
  meta: "Meta",
  microsoft: "Microsoft",
  minimax: "MiniMax",
  mistral: "Mistral",
  moonshot: "Moonshot",
  "nous-research": "Nous Research",
  nvidia: "NVIDIA",
  openai: "OpenAI",
  opencode: "Opencode",
  "open-gpt-x": "OpenGPT-X",
  openrouter: "Openrouter",
  poolside: "Poolside",
  qwen: "Qwen",
  rakuten: "Rakuten",
  sarvam: "Sarvam",
  "step-fun": "StepFun",
  stockmark: "Stockmark",
  tii: "TII",
  trinity: "Trinity",
  upstage: "Upstage",
  xai: "xAI",
  xiaomi: "Xiaomi",
  "z-ai": "Z.AI",
  zyphra: "Zyphra",
  "nex-agi": "Nex AGI",
  cohere: "Cohere",
};

const SLUG_BY_FAMILY = Object.fromEntries(
  Object.entries(FAMILY_BY_SLUG).map(([slug, family]) => [family, slug])
);

function slugForFamily(family) {
  return SLUG_BY_FAMILY[family];
}

// Family inferred from model id when JSON has no family field.
// Mirrors `FAMILY_RULES` from model-registry.mjs but returns the *family name*,
// which is then mapped to a slug.
const FAMILY_RULES = [
  { test: /^claude-/, family: "Anthropic", slug: "anthropic" },
  { test: /^gpt($|-)|^chatgpt-|^o($|-)|^o\d/, family: "OpenAI", slug: "openai" },
  { test: /^gemini-?/, family: "Google", slug: "google" },
  { test: /^grok-?/, family: "xAI", slug: "xai" },
  { test: /^gemma|^diffusiongemma/, family: "Google", slug: "google" },
  { test: /^llama|^codellama/, family: "Meta", slug: "meta" },
  { test: /^phi-?/, family: "Microsoft", slug: "microsoft" },
  { test: /^qwen|^qwq-/, family: "Qwen", slug: "qwen" },
  { test: /^deepseek-?/, family: "DeepSeek", slug: "deepseek" },
  { test: /^kilo-auto-?/, family: "Kilo Code", slug: "kilo-code" },
  { test: /^kimi-?/, family: "Moonshot", slug: "moonshot" },
  { test: /^minimax-?/, family: "MiniMax", slug: "minimax" },
  { test: /^glm-?/, family: "Z.AI", slug: "z-ai" },
  { test: /^mistral-|^codestral|^devstral|^ministral|^mamba-codestral|^magistral|^mixtral/, family: "Mistral", slug: "mistral" },
  { test: /^nemotron-|^nim-?/, family: "NVIDIA", slug: "nvidia" },
  { test: /^openrouter-?/, family: "Openrouter", slug: "openrouter" },
  { test: /^mimo-?/, family: "Xiaomi", slug: "xiaomi" },
  { test: /^hunyuan/, family: "Hunyuan", slug: "hunyuan" },
  { test: /^ling-|^ring-|^ling/, family: "InclusionAI", slug: "inclusion-ai" },
  { test: /^mai-code/, family: "Microsoft", slug: "microsoft" },
  { test: /^nex-n|^nex-n2/, family: "Nex AGI", slug: "nex-agi" },
  { test: /^north-/, family: "Cohere", slug: "cohere" },
];

const INFER_BY_FOLDER = {
  openai: { family: "OpenAI", slug: "openai" },
  google: { family: "Google", slug: "google" },
  xai: { family: "xAI", slug: "xai" },
  meta: { family: "Meta", slug: "meta" },
  microsoft: { family: "Microsoft", slug: "microsoft" },
  qwen: { family: "Qwen", slug: "qwen" },
  deepseek: { family: "DeepSeek", slug: "deepseek" },
  "kilo-code": { family: "Kilo Code", slug: "kilo-code" },
  moonshot: { family: "Moonshot", slug: "moonshot" },
  minimax: { family: "MiniMax", slug: "minimax" },
  "z-ai": { family: "Z.AI", slug: "z-ai" },
  mistral: { family: "Mistral", slug: "mistral" },
  nvidia: { family: "NVIDIA", slug: "nvidia" },
  openrouter: { family: "Openrouter", slug: "openrouter" },
  xiaomi: { family: "Xiaomi", slug: "xiaomi" },
  hunyuan: { family: "Hunyuan", slug: "hunyuan" },
  "inclusion-ai": { family: "InclusionAI", slug: "inclusion-ai" },
  "nex-agi": { family: "Nex AGI", slug: "nex-agi" },
  cohere: { family: "Cohere", slug: "cohere" },
  anthropic: { family: "Anthropic", slug: "anthropic" },
  "abacus-ai": { family: "Abacus.AI", slug: "abacus-ai" },
  "agi-nova": { family: "AGI Nova", slug: "agi-nova" },
  ai21: { family: "AI21", slug: "ai21" },
  "ai-singapore": { family: "AI Singapore", slug: "ai-singapore" },
  baichuan: { family: "Baichuan", slug: "baichuan" },
  baidu: { family: "Baidu", slug: "baidu" },
  bielik: { family: "Bielik", slug: "bielik" },
  "byte-dance": { family: "ByteDance", slug: "byte-dance" },
  "cognitive-computations": { family: "Cognitive Computations", slug: "cognitive-computations" },
  "core-think": { family: "CoreThink", slug: "core-think" },
  databricks: { family: "Databricks", slug: "databricks" },
  "euro-llm": { family: "EuroLLM", slug: "euro-llm" },
  ibm: { family: "IBM", slug: "ibm" },
  "liquid-ai": { family: "Liquid AI", slug: "liquid-ai" },
  marin: { family: "Marin", slug: "marin" },
  "media-tek": { family: "MediaTek", slug: "media-tek" },
  "nous-research": { family: "Nous Research", slug: "nous-research" },
  opencode: { family: "Opencode", slug: "opencode" },
  "open-gpt-x": { family: "OpenGPT-X", slug: "open-gpt-x" },
  poolside: { family: "Poolside", slug: "poolside" },
  rakuten: { family: "Rakuten", slug: "rakuten" },
  sarvam: { family: "Sarvam", slug: "sarvam" },
  "step-fun": { family: "StepFun", slug: "step-fun" },
  stockmark: { family: "Stockmark", slug: "stockmark" },
  tii: { family: "TII", slug: "tii" },
  trinity: { family: "Trinity", slug: "trinity" },
  upstage: { family: "Upstage", slug: "upstage" },
  zyphra: { family: "Zyphra", slug: "zyphra" },
};

const INFER_BY_FOLDER_TO_RULE = INFER_BY_FOLDER;

function inferFamilyForModel(modelKey, upstreamName) {
  const candidates = [modelKey, upstreamName].filter(Boolean);
  for (const key of candidates) {
    const match = FAMILY_RULES.find((rule) => rule.test.test(String(key).toLowerCase()));
    if (match) return { family: match.family, slug: match.slug };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Migration helpers
// ---------------------------------------------------------------------------

function collectModelFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      for (const file of readdirSync(fullPath)) {
        if (file.endsWith(".json")) files.push(join(fullPath, file));
      }
    } else if (stat.isFile() && entry.endsWith(".json")) {
      files.push(fullPath);
    }
  }
  return files;
}

function removeFamilyKey(data) {
  if (data && Object.prototype.hasOwnProperty.call(data, "family")) {
    delete data.family;
  }
  return data;
}

function planForFile(filePath) {
  const fileId = basename(filePath, ".json");
  const folder = basename(dirname(filePath));
  let data;
  try {
    data = JSON.parse(readFileSync(filePath, "utf-8"));
  } catch (error) {
    return { filePath, fileId, folder, ok: false, reason: `JSON parse error: ${error.message}` };
  }

  const explicitFamily = typeof data.family === "string" ? data.family.trim() : "";
  let family = explicitFamily;
  let slug;
  let orphan = false;
  if (family) {
    slug = slugForFamily(family);
    if (!slug) return { filePath, fileId, folder, ok: false, reason: `No slug mapping for family "${family}"` };
  } else {
    const folderFamily = INFER_BY_FOLDER[folder];
    if (folderFamily) {
      const inferred = INFER_BY_FOLDER_TO_RULE[folder];
      if (inferred) {
        family = inferred.family;
        slug = inferred.slug;
      }
    }
    if (!slug) {
      const upstreamNames = [];
      if (data.providerConfig && typeof data.providerConfig === "object") {
        for (const config of Object.values(data.providerConfig)) {
          if (config && typeof config.upstream === "string") upstreamNames.push(config.upstream);
        }
      }
      const inferred =
        inferFamilyForModel(fileId, undefined) ??
        upstreamNames.map((name) => inferFamilyForModel(name, undefined)).find(Boolean);
      if (!inferred) {
        orphan = true;
      } else {
        family = inferred.family;
        slug = inferred.slug;
      }
    }
  }

  return {
    filePath,
    fileId,
    folder,
    family,
    slug,
    orphan,
    ok: true,
    action: orphan
      ? { from: `${folder} -> ROOT (orphan)`, targetFolder: null, removingFamily: Boolean(explicitFamily), droppingFolder: true }
      : {
          from: `${slug === folder ? "(same)" : folder} -> ${slug}`,
          targetFolder: slug,
          removingFamily: Boolean(explicitFamily),
          droppingFolder: slug !== folder,
        },
  };
}

function applyPlan(plan) {
  const data = JSON.parse(readFileSync(plan.filePath, "utf-8"));
  removeFamilyKey(data);
  const serialized = `${JSON.stringify(data, null, 2)}\n`;

  let newPath;
  if (plan.orphan) {
    newPath = join(modelsDir, `${plan.fileId}.json`);
  } else {
    const targetDir = join(modelsDir, plan.slug);
    if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });
    newPath = join(targetDir, `${plan.fileId}.json`);
  }

  writeFileSync(newPath, serialized);
  if (newPath !== plan.filePath) rmSync(plan.filePath);

  const sourceDir = dirname(plan.filePath);
  if (sourceDir !== dirname(newPath) && existsSync(sourceDir)) {
    const remaining = readdirSync(sourceDir);
    if (remaining.length === 0) rmSync(sourceDir, { recursive: true, force: true });
  }

  return newPath;
}

function main() {
  const dryRun = process.argv.includes("--apply") ? false : true;
  const files = collectModelFiles(modelsDir);
  const plans = files.map(planForFile);
  const failed = plans.filter((p) => !p.ok);

  if (failed.length) {
    console.error("Migration planning failed for:");
    for (const plan of failed) console.error(`  ${plan.fileId} (folder=${plan.folder}): ${plan.reason}`);
    process.exit(1);
  }

  const moves = plans.filter((p) => p.action.droppingFolder);
  const writes = plans.filter((p) => p.action.removingFamily);

  console.log(`Found ${plans.length} model files.`);
  console.log(`  Files to move: ${moves.length}`);
  console.log(`  Files that will lose the "family" key: ${writes.length}`);

  if (dryRun) {
    console.log("\nDRY-RUN — pass --apply to perform the migration.");
    for (const plan of plans.filter((p) => p.action.droppingFolder || p.action.removingFamily)) {
      console.log(`  ${plan.fileId}: ${plan.action.from} (family=${plan.family || "inferred"})`);
    }
    return;
  }

  for (const plan of plans) {
    const newPath = applyPlan(plan);
    console.log(`  -> ${newPath.replace(`${rootDir}/`, "")}`);
  }
  console.log("\nMigration complete.");
}

main();
