import { Effect } from "effect";

import { buildIndex, prune } from "#models/model-store.ts";
import { listFiles, readText, writeText } from "#models/fs.ts";
import { basename, dirname, fromFileUrl, join } from "#models/paths.ts";
import { orderScripts, runSteps, spawnScript, type RefreshStep } from "#models/refresh.ts";
import { packageModelsDir, runScript } from "./shared.ts";

const SCRIPT_DIR = dirname(fromFileUrl(import.meta.url));
const modelsDir = packageModelsDir();
const SELF = basename(fromFileUrl(import.meta.url));

const TAIL_SCRIPTS = ["aa.ts", "enrich.ts"];

function refreshScripts(): string[] {
  const names = listFiles(SCRIPT_DIR, "*.ts")
    .filter((name) => name !== SELF)
    .filter(
      (name) =>
        TAIL_SCRIPTS.includes(name) || readText(join(SCRIPT_DIR, name)).includes("sync(")
    );
  return orderScripts(names, TAIL_SCRIPTS);
}

function refreshedProviders(): string[] {
  const providers = new Set<string>();
  for (const entry of Object.values(buildIndex(modelsDir))) {
    for (const provider of entry.data.providers ?? []) providers.add(provider);
  }
  return [...providers].sort();
}

async function main(): Promise<void> {
  const providers = refreshedProviders();
  const before = snapshotProviderModels(providers);

  const steps: RefreshStep[] = refreshScripts().map((script) => ({
    script,
    path: join(SCRIPT_DIR, script),
  }));
  const result = await Effect.runPromise(runSteps(steps, (step) => spawnScript(step.path)));

  for (const failure of result.failed) console.error(failure.message);
  if (result.failed.length > 0) process.exitCode = 1;

  const pruned = await prune(modelsDir);
  if (pruned.length > 0) {
    console.log(`[models] pruned ${pruned.length} dead entries: ${pruned.join(", ")}`);
  }

  const after = snapshotProviderModels(providers);
  const target = summaryPath(Bun.argv);
  if (target) {
    writeText(target, generateSummary(before, after));
    console.log(`PR summary written to ${target}`);
  }
}

type ProviderSnapshot = Map<string, Set<string>>;

function snapshotProviderModels(providers: string[]): ProviderSnapshot {
  const snapshot: ProviderSnapshot = new Map(providers.map((provider) => [provider, new Set<string>()]));

  for (const [modelId, entry] of Object.entries(buildIndex(modelsDir))) {
    const publicId = entry.id || modelId;
    for (const provider of entry.data.providers ?? []) {
      snapshot.get(provider)?.add(publicId);
    }
  }

  return snapshot;
}

function generateSummary(before: ProviderSnapshot, after: ProviderSnapshot): string {
  const added: Array<{ model: string; provider: string }> = [];
  const removed: Array<{ model: string; provider: string }> = [];

  for (const provider of new Set([...before.keys(), ...after.keys()])) {
    const oldKeys = before.get(provider) ?? new Set<string>();
    const newKeys = after.get(provider) ?? new Set<string>();

    for (const key of newKeys) {
      if (!oldKeys.has(key)) added.push({ model: key, provider });
    }
    for (const key of oldKeys) {
      if (!newKeys.has(key)) removed.push({ model: key, provider });
    }
  }

  const lines: string[] = [];
  for (const entry of added.sort((a, b) => a.model.localeCompare(b.model))) {
    lines.push(`+ ${entry.model} (${entry.provider})`);
  }
  for (const entry of removed.sort((a, b) => a.model.localeCompare(b.model))) {
    lines.push(`- ${entry.model} (${entry.provider})`);
  }

  return lines.length > 0 ? `Models:\n${lines.join("\n")}\n` : "";
}

function summaryPath(argv: readonly string[]): string | null {
  const index = argv.indexOf("--summary");
  if (index < 0) return null;
  const value = argv[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

runScript(main);
