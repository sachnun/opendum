#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { syncProviderModels } from "./model-registry.mjs";

const PROVIDER_NAME = "perch";

// Perch serves its free "Starter" pool (see
// https://www.perchai.app/docs/concepts/models) through the model-call proxy
// endpoint on app.perchai.app; every request pins a model option id via
// manualModelOptionId. The catalog below was reversed from the perchai-cli npm
// bundle (v2.4.98, dist/perch.mjs) and checked against the published Starter
// pool: key = opendum canonical model id, value = the Perch pool alias the
// account's Starter plan can pin. Anything outside the Starter pool is paid
// (Pro tier), so it is intentionally not listed here.
const PERCH_MODEL_UPSTREAMS = new Map([
  ["qwen3.6", "qwen-3.6"],
  ["kimi-k2.5", "kimi-2.5"],
  ["glm-5", "glm-5"],
  ["qwen3-coder", "qwen3-coder"],
  ["nemotron-3-super", "nemotron-super"],
  ["minimax-m2.7", "minimax-m2.7-free"],
  ["minimax-m3", "minimax-m3-free"],
  ["gemma-4-e2b", "gemma-4-e2b"],
  ["gemma-4-31b", "gemma-4-31b"],
]);

async function main() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const modelsDir = resolve(scriptDir, "../models");

  const result = syncProviderModels(modelsDir, PROVIDER_NAME, PERCH_MODEL_UPSTREAMS);

  if (result.added.length === 0 && result.removed.length === 0 && result.updated.length === 0) {
    console.log(`Perch founder-pool models are already up to date (${PERCH_MODEL_UPSTREAMS.size} models).`);
  } else {
    console.log(`Perch: ${PERCH_MODEL_UPSTREAMS.size} models (added ${result.added.length}, removed ${result.removed.length}, updated ${result.updated.length}).`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
