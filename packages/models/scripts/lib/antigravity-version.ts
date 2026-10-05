import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchText } from "#models/lib/http.ts";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(scriptDir, "../..");
const repoRoot = resolve(packageDir, "../..");

const ANTIGRAVITY_VERSION_SOURCES = [
  "https://releasebot.io/updates/google/antigravity",
  "https://antigravity.google/changelog",
];
const VERSION_FETCH_TIMEOUT_MS = 15_000;

const PROXY_PROVIDER_PATH = resolve(repoRoot, "packages/providers/src/antigravity.ts");
const WEB_CONSTANTS_PATH = resolve(
  repoRoot,
  "apps/web/server/lib/providers/antigravity/constants.ts"
);

const PROXY_USER_AGENT_REGEX = /(antigravity\/)(\d+\.\d+\.\d+)(\s)/;
const WEB_USER_AGENT_REGEX =
  /((?:export\s+)?const USER_AGENT\s*=\s*`antigravity\/)(\d+\.\d+\.\d+)(\s+linux\/amd64`;)/;

export function parseLatestVersion(html: string): string | null {
  const versionRegex = /\b(\d+\.\d+\.\d+)\b/g;
  const versions: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = versionRegex.exec(html)) !== null) {
    const version = match[1];
    if (version.startsWith("1.") && !version.startsWith("1.0")) {
      versions.push(version);
    }
  }

  if (versions.length === 0) {
    return null;
  }

  versions.sort((a, b) => compareSemver(b, a));

  return versions[0];
}

export function compareSemver(a: string, b: string): number {
  const [aMajor, aMinor, aPatch] = a.split(".").map(Number);
  const [bMajor, bMinor, bPatch] = b.split(".").map(Number);
  if (aMajor !== bMajor) return aMajor > bMajor ? 1 : -1;
  if (aMinor !== bMinor) return aMinor > bMinor ? 1 : -1;
  if (aPatch !== bPatch) return aPatch > bPatch ? 1 : -1;
  return 0;
}

function getCurrentVersion(): string | null {
  const source = readFileSync(PROXY_PROVIDER_PATH, "utf-8");
  const match = source.match(PROXY_USER_AGENT_REGEX);
  return match ? match[2] : null;
}

function updateVersion(newVersion: string): void {
  for (const [filePath, regex] of [
    [PROXY_PROVIDER_PATH, PROXY_USER_AGENT_REGEX],
    [WEB_CONSTANTS_PATH, WEB_USER_AGENT_REGEX],
  ]) {
    const source = readFileSync(filePath, "utf-8");
    const updated = source.replace(regex, `$1${newVersion}$3`);
    writeFileSync(filePath, updated);
  }
}

export async function syncUserAgent(dryRun: boolean): Promise<void> {
  const currentVersion = getCurrentVersion();
  if (!currentVersion) {
    console.warn("[antigravity] Could not find User-Agent version in the proxy provider, skipping.");
    return;
  }

  console.log(`[antigravity] Current proxy User-Agent version is ${currentVersion}`);

  let latestVersion: string | null = null;
  for (const source of ANTIGRAVITY_VERSION_SOURCES) {
    try {
      const html = await fetchText(source, {
        label: source,
        timeout: VERSION_FETCH_TIMEOUT_MS,
        headers: { Accept: "text/html" },
      });
      latestVersion = parseLatestVersion(html);
      if (latestVersion) {
        console.log(`[antigravity] Latest version from ${source} is ${latestVersion}`);
        break;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[antigravity] Fetch failed for ${source} (${message})`);
    }
  }

  if (!latestVersion) {
    console.warn("[antigravity] Could not parse version from any source, skipping.");
    return;
  }

  if (compareSemver(latestVersion, currentVersion) > 0) {
    if (dryRun) {
      console.log(`[antigravity] Would update User-Agent version ${currentVersion} -> ${latestVersion}`);
    } else {
      updateVersion(latestVersion);
      console.log(`[antigravity] Updated User-Agent version ${currentVersion} -> ${latestVersion}`);
    }
  } else {
    console.log("[antigravity] User-Agent version is already up to date.");
  }
}
