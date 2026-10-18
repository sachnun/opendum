import { idMap, sync } from "#models/model-store.ts";
import { runFetchText } from "#models/sync/http.ts";
import { packageModelsDir, runScript } from "./shared.ts";

const PROVIDER_NAME = "harbor";
const HARBOR_MODELS_URL = "https://tokenharbor.ai/models";

interface HarborEntry {
  surface: string;
  isFree: boolean;
  inputModalities: string | null;
}

function unescapeFlightPayload(html: string): string {
  return html.replace(/\\"/g, '"');
}

function parseModelEntries(html: string): HarborEntry[] {
  const unescaped = unescapeFlightPayload(html);
  const entries: HarborEntry[] = [];
  const seen = new Set<string>();

  const pattern =
    /"surface":"([^"]+)".*?"isFree":(true|false),.*?"inputModalities":(\[[^\]]*\]),"outputModalities":(\[[^\]]*\])/g;

  for (const match of unescaped.matchAll(pattern)) {
    const surface = match[1];
    if (!surface || seen.has(surface)) continue;
    seen.add(surface);
    entries.push({ surface, isFree: match[2] === "true", inputModalities: match[3] ?? null });
  }

  const fallbackPattern = /"surface":"([^"]+)"/g;
  for (const match of unescaped.matchAll(fallbackPattern)) {
    const surface = match[1];
    if (!surface || seen.has(surface)) continue;
    if (!surface.endsWith(":free")) continue;
    seen.add(surface);
    entries.push({ surface, isFree: true, inputModalities: null });
  }

  return entries;
}

function isFreeModel(entry: HarborEntry): boolean {
  return entry.isFree || entry.surface.endsWith(":free");
}

function supportsTextOutput(entry: HarborEntry): boolean {
  if (!entry.inputModalities) return true;
  try {
    const parsed: unknown = JSON.parse(entry.inputModalities);
    if (!Array.isArray(parsed) || parsed.length === 0) return true;
    return parsed.includes("text");
  } catch {
    return true;
  }
}

function toModelKey(modelId: string): string {
  const modelKey = modelId
    .replace(/[:/]/g, "-")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-{2,}/g, "-");

  return modelKey.endsWith("-free") ? modelKey.slice(0, -"-free".length) : modelKey;
}

async function fetchHarborFreeModelIds(): Promise<string[]> {
  const html = await runFetchText(HARBOR_MODELS_URL, { label: "Harbor /models catalog page" });
  const ids = parseModelEntries(html)
    .filter((entry) => isFreeModel(entry) && supportsTextOutput(entry))
    .map((entry) => entry.surface.trim())
    .filter((id) => id.length > 0);

  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

async function main(): Promise<void> {
  const modelsDir = packageModelsDir();

  const modelIds = await fetchHarborFreeModelIds();
  const modelMap = idMap(modelIds, toModelKey);

  const result = await sync(modelsDir, PROVIDER_NAME, modelMap);

  if (result.added.length === 0 && result.removed.length === 0 && result.updated.length === 0) {
    console.log(`Harbor free models are already up to date (${modelMap.size} models).`);
  } else {
    console.log(
      `Harbor: ${modelMap.size} models (added ${result.added.length}, removed ${result.removed.length}, updated ${result.updated.length}).`
    );
  }
}

runScript(main);
