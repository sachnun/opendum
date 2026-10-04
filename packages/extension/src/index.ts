import { globSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface Discoverable {
  readonly name: string;
}

export type DiscoverOptions = {
  pattern: string;
  dir: string | URL;
  key?: string;
  filter?: (file: string) => boolean;
};

export async function discoverModules<T extends Discoverable>(options: DiscoverOptions): Promise<T[]> {
  const { pattern, dir, key = "extension", filter } = options;
  const dirUrl = dir instanceof URL ? dir : pathToFileURL(dir.endsWith("/") ? dir : `${dir}/`);
  const dirPath = fileURLToPath(dirUrl);
  const seen = new Set<string>();
  const modules: T[] = [];

  for (const file of globSync(pattern, { cwd: dirPath }).sort()) {
    if (filter && !filter(file)) continue;
    const imported = (await import(new URL(file, dirUrl).href)) as Record<string, unknown>;
    const value = imported[key];
    if (!value) throw new Error(`discoverModules: ${file} has no "${key}" export`);
    const discovered = value as T;
    if (!discovered.name) throw new Error(`discoverModules: ${file} has no name`);
    if (seen.has(discovered.name)) throw new Error(`discoverModules: duplicate name "${discovered.name}" (${file})`);
    seen.add(discovered.name);
    modules.push(discovered);
  }

  return modules;
}
