#!/usr/bin/env node

/**
 * Antigravity version refresh script.
 *
 * Fetches the latest version from the Antigravity changelog and updates
 * ANTIGRAVITY_USER_AGENT in constants.ts to prevent version-gating errors.
 *
 * The upstream Google Code Assist API checks the User-Agent version and
 * gates access to newer models (e.g. Gemini 3.1 Pro requires >= 1.18.3).
 * Keeping this version current prevents "not available on this version" errors.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Primary: Releasebot (static HTML, always parseable)
// Fallback: official changelog (SPA, may return empty content)
const VERSION_SOURCES = [
  "https://releasebot.io/updates/google/antigravity",
  "https://antigravity.google/changelog",
];
const FETCH_TIMEOUT_MS = 15_000;
const MAX_FETCH_ATTEMPTS = 3;

const CONSTANTS_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../packages/shared/src/proxy/providers/antigravity/constants.ts"
);

// Regex to extract version from User-Agent constant
const USER_AGENT_REGEX =
  /^(export const ANTIGRAVITY_USER_AGENT = `antigravity\/)(\d+\.\d+\.\d+)( \$\{getAntigravityPlatform\(\)\}`;)$/m;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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

// ---------------------------------------------------------------------------
// Version parsing
// ---------------------------------------------------------------------------

/**
 * Parse the latest version from the Antigravity changelog HTML.
 *
 * The changelog contains version entries like:
 *   "1.20.6Mar 17, 2026"  or  <h2>1.20.6</h2>  or  similar patterns.
 *
 * We extract all semver-like patterns and return the highest one.
 */
function parseLatestVersion(html) {
  // Match version patterns like 1.20.6, 1.18.3, etc.
  const versionRegex = /\b(\d+\.\d+\.\d+)\b/g;
  const versions = [];
  let match;

  while ((match = versionRegex.exec(html)) !== null) {
    const v = match[1];
    // Filter to plausible Antigravity versions (1.x.x range)
    if (v.startsWith("1.") && !v.startsWith("1.0")) {
      versions.push(v);
    }
  }

  if (versions.length === 0) {
    return null;
  }

  // Sort by semver descending and return highest
  versions.sort((a, b) => {
    const [aMaj, aMin, aPat] = a.split(".").map(Number);
    const [bMaj, bMin, bPat] = b.split(".").map(Number);
    return bMaj - aMaj || bMin - aMin || bPat - aPat;
  });

  return versions[0];
}

/**
 * Compare two semver strings. Returns:
 *   1  if a > b
 *   0  if a === b
 *  -1  if a < b
 */
function compareSemver(a, b) {
  const [aMaj, aMin, aPat] = a.split(".").map(Number);
  const [bMaj, bMin, bPat] = b.split(".").map(Number);
  if (aMaj !== bMaj) return aMaj > bMaj ? 1 : -1;
  if (aMin !== bMin) return aMin > bMin ? 1 : -1;
  if (aPat !== bPat) return aPat > bPat ? 1 : -1;
  return 0;
}

// ---------------------------------------------------------------------------
// Update constants.ts
// ---------------------------------------------------------------------------

function getCurrentVersion() {
  const source = readFileSync(CONSTANTS_PATH, "utf-8");
  const match = source.match(USER_AGENT_REGEX);
  return match ? match[2] : null;
}

function updateVersion(newVersion) {
  const source = readFileSync(CONSTANTS_PATH, "utf-8");
  const updated = source.replace(
    USER_AGENT_REGEX,
    `$1${newVersion}$3`
  );
  writeFileSync(CONSTANTS_PATH, updated);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const currentVersion = getCurrentVersion();
  if (!currentVersion) {
    throw new Error(
      "Could not find ANTIGRAVITY_USER_AGENT version in constants.ts"
    );
  }

  console.log(`Antigravity: current version in constants.ts is ${currentVersion}`);

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
      const msg = error instanceof Error ? error.message : String(error);
      console.warn(`Antigravity: fetch failed for ${source} (${msg})`);
    }
  }

  if (!latestVersion) {
    console.warn("Antigravity: could not parse version from any source, skipping.");
    return;
  }

  if (compareSemver(latestVersion, currentVersion) > 0) {
    updateVersion(latestVersion);
    console.log(
      `Antigravity: updated User-Agent version ${currentVersion} -> ${latestVersion}`
    );
  } else {
    console.log("Antigravity: version is already up to date.");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
