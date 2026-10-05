import { discoverModules } from "@opendum/extension";
import type { ModelSource } from "./source.ts";

const NON_SOURCES = new Set(["models.ts", "runner.ts", "source.ts", "cli.ts"]);

export function orderSources(sources: ModelSource[]): ModelSource[] {
  return [...sources].sort((left, right) => (left.order ?? 0) - (right.order ?? 0) || left.name.localeCompare(right.name));
}

export function discoverSources(dir: string | URL = new URL("./", import.meta.url)): Promise<ModelSource[]> {
  return discoverModules<ModelSource>({
    pattern: "*.ts",
    dir,
    key: "source",
    filter: (file) => !NON_SOURCES.has(file) && !file.endsWith(".test.ts"),
  });
}
