import { pathToFileURL } from "node:url";
import type { ModelSource } from "./source.ts";

export function isDirectRun(metaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return metaUrl === pathToFileURL(entry).href;
}

export function runSourceCli(source: ModelSource): void {
  source.run().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
