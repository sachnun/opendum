import { readFileSync, writeFileSync } from "node:fs";

export interface CliVersionTarget {
  label: string;
  path: string;
  pattern: RegExp;
}

function globalize(pattern: RegExp): RegExp {
  return new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
}

/**
 * Point every reference of an emulated CLI version at the latest release.
 *
 * Each target's pattern must capture the version in its second group. Every
 * occurrence inside the file is replaced, so copies scattered across the
 * provider, the quota fetchers and the web app all converge on the same value
 * instead of drifting apart.
 */
export function syncCliVersion(label: string, targets: CliVersionTarget[], latest: string | null): void {
  if (!latest) {
    console.warn(`[${label}] Could not determine the latest version, skipping.`);
    return;
  }

  let updated = 0;
  for (const target of targets) {
    const source = readFileSync(target.path, "utf-8");
    const pattern = globalize(target.pattern);
    const current = [...source.matchAll(pattern)].map((match) => match[2]);
    if (current.length === 0) {
      console.warn(`[${label}] Could not find the version in ${target.label}, skipping.`);
      continue;
    }
    if (current.every((version) => version === latest)) continue;
    writeFileSync(target.path, source.replace(pattern, `$1${latest}$3`));
    console.log(`[${label}] Updated ${target.label} ${[...new Set(current)].join(", ")} -> ${latest}`);
    updated += 1;
  }

  if (updated === 0) {
    console.log(`[${label}] CLI versions are up to date (${latest}).`);
  }
}
