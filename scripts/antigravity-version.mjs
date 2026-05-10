#!/usr/bin/env node

/**
 * Antigravity version refresh script.
 *
 * Fetches the latest version from the Antigravity changelog and updates the
 * User-Agent used by the Go proxy Antigravity provider.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION_SOURCES = [
  "https://releasebot.io/updates/google/antigravity",
  "https://antigravity.google/changelog",
];
const FETCH_TIMEOUT_MS = 15_000;
const MAX_FETCH_ATTEMPTS = 3;

const PROXY_PROVIDER_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../apps/proxy/internal/providers/google_code_assist.go"
);

const USER_AGENT_REGEX =
  /((?:userAgent:\s*)"antigravity\/)(\d+\.\d+\.\d+)(\s+"\s*\+\s*platform)/;

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function fetchWithRetry(url, label = "resource") {
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, {
        headers: {
          Accept: "text/html",
          "User-Agent": "opendum-version-check/1.0",
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (!response.ok) {
        throw new Error(
          `Failed to fetch ${label} (${response.status} ${response.statusText})`
        );
      }

      return await response.text();
    } catch (error) {
      lastError = error;
      if (attempt < MAX_FETCH_ATTEMPTS) {
        await sleep(attempt * 1_000);
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Failed to fetch ${label}`);
}

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
  const match = source.match(USER_AGENT_REGEX);
  return match ? match[2] : null;
}

function updateVersion(newVersion) {
  const source = readFileSync(PROXY_PROVIDER_PATH, "utf-8");
  const updated = source.replace(USER_AGENT_REGEX, `$1${newVersion}$3`);
  writeFileSync(PROXY_PROVIDER_PATH, updated);
}

async function main() {
  const currentVersion = getCurrentVersion();
  if (!currentVersion) {
    throw new Error("Could not find Antigravity User-Agent version in Go proxy provider");
  }

  console.log(`Antigravity: current proxy User-Agent version is ${currentVersion}`);

  let latestVersion;
  for (const source of VERSION_SOURCES) {
    try {
      const html = await fetchWithRetry(source, source);
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
    console.log(
      `Antigravity: updated proxy User-Agent version ${currentVersion} -> ${latestVersion}`
    );
  } else {
    console.log("Antigravity: proxy User-Agent version is already up to date.");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
