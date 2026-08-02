#!/usr/bin/env node

/**
 * Shared utilities for Opendum model refresh scripts.
 *
 * This module consolidates common helper functions (sleep, fetch with retry)
 * that were independently reimplemented across all provider sync scripts.
 * Import these functions instead of duplicating them.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of fetch attempts before giving up. */
export const MAX_FETCH_ATTEMPTS = 3;

/** Default timeout (ms) for each fetch request. */
export const FETCH_TIMEOUT_MS = 20_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Promise-based sleep / delay.
 * @param {number} ms  Milliseconds to sleep.
 * @returns {Promise<void>}
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch a URL with automatic retry on failure.
 *
 * Attempts up to `options.attempts` times with exponential-ish backoff
 * (attempt * 1_000 ms). Returns parsed JSON or text depending on
 * `options.responseType`.
 *
 * @param {string}  url                          URL to fetch.
 * @param {object}  [options]                    Optional parameters.
 * @param {number}  [options.attempts]           Max retries (default: MAX_FETCH_ATTEMPTS).
 * @param {number}  [options.timeout]            Per-request timeout in ms (default: FETCH_TIMEOUT_MS).
 * @param {string}  [options.responseType]       "json" or "text" (default: "json").
 * @param {string}  [options.label]              Human-readable label for error messages.
 * @param {object}  [options.headers]            Extra request headers.
 * @returns {Promise<any>}                       Parsed response body.
 */
export async function fetchWithRetry(url, options = {}) {
  const {
    attempts = MAX_FETCH_ATTEMPTS,
    timeout = FETCH_TIMEOUT_MS,
    responseType = "json",
    label = url,
    headers = {},
  } = options;

  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { Accept: "application/json", ...headers },
        signal: AbortSignal.timeout(timeout),
      });

      if (!response.ok) {
        throw new Error(
          `Failed to fetch ${label} (${response.status} ${response.statusText})`
        );
      }

      return responseType === "text" ? await response.text() : await response.json();
    } catch (error) {
      lastError = error;

      if (attempt < attempts) {
        await sleep(attempt * 1_000);
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Failed to fetch ${label}`);
}

/**
 * Convenience wrapper: fetch a URL and return parsed JSON.
 * @param {string} url
 * @param {object} [options]
 * @returns {Promise<any>}
 */
export function fetchJson(url, options = {}) {
  return fetchWithRetry(url, { ...options, responseType: "json" });
}

/**
 * Convenience wrapper: fetch a URL and return plain text.
 * @param {string} url
 * @param {object} [options]
 * @returns {Promise<string>}
 */
export function fetchText(url, options = {}) {
  return fetchWithRetry(url, { ...options, responseType: "text", headers: { Accept: "text/plain", ...options.headers } });
}

// ---------------------------------------------------------------------------
// CLI flags & paths
// ---------------------------------------------------------------------------

/**
 * Parse common CLI flags shared by every refresh script.
 * @param {string[]} [argv]  Arguments (default: process.argv.slice(2)).
 * @returns {{ dryRun: boolean, verbose: boolean }}
 */
export function parseFlags(argv = process.argv.slice(2)) {
  const args = new Set(argv);
  return {
    dryRun: args.has("--dry-run"),
    verbose: args.has("--verbose") || args.has("-v"),
  };
}

/**
 * Resolve the repo `models/` directory from a script's `import.meta.url`.
 * @param {string} metaUrl  `import.meta.url` of the calling script.
 * @returns {string}
 */
export function resolveModelsDir(metaUrl) {
  return resolve(dirname(fileURLToPath(metaUrl)), "..", "models");
}

// ---------------------------------------------------------------------------
// Model map helpers
// ---------------------------------------------------------------------------

/**
 * Pick a unique map key for `upstream`. If `baseKey` is already taken by a
 * different upstream, append `-2`, `-3`, ... until a free key is found.
 *
 * @param {Map<string,string>} map       modelKey -> upstream (mutated by callers).
 * @param {string} baseKey               Preferred key.
 * @param {string} upstream              Upstream id the key maps to.
 * @returns {string}                     The unique key to use.
 */
export function uniqueModelKey(map, baseKey, upstream) {
  if (!map.has(baseKey) || map.get(baseKey) === upstream) return baseKey;
  let suffix = 2;
  while (map.has(`${baseKey}-${suffix}`)) suffix += 1;
  return `${baseKey}-${suffix}`;
}

/**
 * Print the standard sync result summary shared by every refresh script.
 *
 * @param {object} params
 * @param {string} params.label    Prefix, e.g. "[kiro]".
 * @param {number} params.count    Model count in the map.
 * @param {{added: string[], removed: string[], updated: string[]}} params.result
 * @param {boolean} [params.would] True when dry-run: report what *would* change.
 * @param {string}  [params.extra] Extra trailing summary item, e.g. "metadata 3".
 */
export function logSyncResult({ label, count, result, would = false, extra = null }) {
  const { added, removed, updated } = result;
  const noChanges = added.length === 0 && removed.length === 0 && updated.length === 0;

  if (noChanges) {
    console.log(`${label} models ${would ? "would be" : "are"} already up to date (${count} models).`);
    return;
  }

  const parts = [`added ${added.length}`, `removed ${removed.length}`, `updated ${updated.length}`];
  if (extra) parts.push(extra);
  console.log(`${label} ${would ? "would sync" : "synced"} ${count} models (${parts.join(", ")}).`);

  for (const [name, keys] of [
    ["Added", added],
    ["Removed", removed],
    ["Updated", updated],
  ]) {
    if (keys.length > 0) console.log(`  ${name}: ${keys.join(", ")}`);
  }
}
