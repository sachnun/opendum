#!/usr/bin/env bun

/**
 * Shared utilities for Opendum model refresh scripts.
 *
 * This module consolidates common helper functions (sleep, fetch with retry)
 * that were independently reimplemented across all provider sync scripts.
 * Import these functions instead of duplicating them.
 */

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
