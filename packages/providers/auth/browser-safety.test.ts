import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const PACKAGE_ROOT = resolve(import.meta.dir, "..");
const ROOT = resolve(PACKAGE_ROOT, "../..");

const ENTRY_POINTS = [
  "provider-accounts.ts",
  "registry-specs.ts",
  "auth/config.ts",
  "auth/tier.ts",
  "contract/index.ts",
  "contract/types.ts",
];

const PREFIXES: Record<string, string> = {
  "@opendum/providers": "packages/providers",
  "@opendum/models": "packages/models",
  "@opendum/platform": "packages/platform",
};

function targetOf(spec: string, from: string): string[] {
  if (spec.startsWith(".")) {
    const base = resolve(dirname(from), spec);
    return [`${base}.ts`, join(base, "index.ts")];
  }

  for (const [prefix, dir] of Object.entries(PREFIXES)) {
    if (spec === prefix) return [join(ROOT, dir, "index.ts")];
    if (spec.startsWith(`${prefix}/`)) {
      const base = join(ROOT, dir, spec.slice(prefix.length + 1));
      return [`${base}.ts`, join(base, "index.ts")];
    }
  }

  return [];
}

function importsOf(source: string): string[] {
  return [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1]);
}

function nodeImports(): string[] {
  const seen = new Set<string>();
  const found: string[] = [];
  const queue = ENTRY_POINTS.map((entry) => join(PACKAGE_ROOT, entry));

  while (queue.length > 0) {
    const file = queue.pop();
    if (!file || seen.has(file) || !existsSync(file)) continue;
    seen.add(file);

    for (const spec of importsOf(readFileSync(file, "utf8"))) {
      if (spec.startsWith("node:")) {
        found.push(`${spec} in ${file.slice(ROOT.length + 1)}`);
        continue;
      }

      const next = targetOf(spec, file).find((candidate) => existsSync(candidate));
      if (next) queue.push(next);
    }
  }

  return found;
}

describe("browser safe provider modules", () => {
  it("never reaches node builtins from the modules the web app imports", () => {
    expect(nodeImports()).toEqual([]);
  });
});
