#!/usr/bin/env node

/**
 * Antigravity version refresh script.
 *
 * Fetches the latest version from the Antigravity changelog and updates the
 * User-Agent used by the Go proxy and dashboard Antigravity providers.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sleep, fetchText, MAX_FETCH_ATTEMPTS } from "./lib/shared.mjs";

const VERSION_SOURCES = [
  "https://releasebot.io/updates/google/antigravity",
  "https://antigravity.google/changelog",
];
const FETCH_TIMEOUT_MS = 15_000;

const PROXY_PROVIDER_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../apps/proxy/internal/providers/google_code_assist.go"
);
const DASHBOARD_CONSTANTS_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../apps/dashboard/server/lib/providers/antigravity/constants.ts"
);

const PROXY_USER_AGENT_REGEX =
  /((?:const\s+antigravityUserAgent\s*=\s*"antigravity\/))(\d+\.\d+\.\d+)(\s+")/;
const DASHBOARD_USER_AGENT_REGEX =
  /((?:export\s+)?const USER_AGENT\s*=\s*`antigravity\/)(\d+\.\d+\.\d+)(\s+linux\/amd64`;)/;

function parseLatestVersion(html) {
  const versionRegex = /\b(\d+\.\d+\.\d+)\b/g;
  const versions = [];
  let match;

  while ((match = versionRegex.exec(html)) !== null) {
    const version = match[1];
    if (version.startsWith("1.") && !version.startsWith("1.0")) {
      versions.push(version);
    }
  }

  if (versions.length === 0) {
    return null;
  }

  versions.sort((a, b) => {
    const [aMajor, aMinor, aPatch] = a.split(".").map(Number);
    const [bMajor, bMinor, bPatch] = b.split(".").map(Number);
    return bMajor - aMajor || bMinor - aMinor || bPatch - aPatch;
  });

  return versions[0];
}

function compareSemver(a, b) {
  const [aMajor, aMinor, aPatch] = a.split(".").map(Number);
  const [bMajor, bMinor, bPatch] = b.split(".").map(Number);
  if (aMajor !== bMajor) return aMajor > bMajor ? 1 : -1;
  if (aMinor !== bMinor) return aMinor > bMinor ? 1 : -1;
  if (aPatch !== bPatch) return aPatch > bPatch ? 1 : -1;
  return 0;
}

function getCurrentVersion() {
  const source = readFileSync(PROXY_PROVIDER_PATH, "utf-8");
  const match = source.match(PROXY_USER_AGENT_REGEX);
  return match ? match[2] : null;
}

function updateVersion(newVersion) {
  for (const [filePath, regex] of [
    [PROXY_PROVIDER_PATH, PROXY_USER_AGENT_REGEX],
    [DASHBOARD_CONSTANTS_PATH, DASHBOARD_USER_AGENT_REGEX],
  ]) {
    const source = readFileSync(filePath, "utf-8");
    const updated = source.replace(regex, `$1${newVersion}$3`);
    writeFileSync(filePath, updated);
  }
}

async function main() {
  const currentVersion = getCurrentVersion();
  if (!currentVersion) {
    console.warn("Antigravity: could not find User-Agent version in Go proxy provider, skipping.");
    return;
  }

  console.log(`Antigravity: current proxy User-Agent version is ${currentVersion}`);

  let latestVersion;
  for (const source of VERSION_SOURCES) {
    try {
      const html = await fetchText(source, { label: source, timeout: FETCH_TIMEOUT_MS, headers: { Accept: "text/html" } });
      latestVersion = parseLatestVersion(html);
      if (latestVersion) {
        console.log(`Antigravity: latest version from ${source} is ${latestVersion}`);
        break;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Antigravity: fetch failed for ${source} (${message})`);
    }
  }

  if (!latestVersion) {
    console.warn("Antigravity: could not parse version from any source, skipping.");
    return;
  }

  if (compareSemver(latestVersion, currentVersion) > 0) {
    updateVersion(latestVersion);
    console.log(`Antigravity: updated User-Agent version ${currentVersion} -> ${latestVersion}`);
  } else {
    console.log("Antigravity: User-Agent version is already up to date.");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
