/**
 * Shared fetch utilities for the model refresh scripts.
 *
 * Provides retrying helpers used by every provider scraper so retry and
 * timeout behaviour stays consistent.
 */

import pRetry from "p-retry";

export const MAX_FETCH_ATTEMPTS = 3;
export const FETCH_TIMEOUT_MS = 20_000;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface FetchOptions {
  attempts?: number;
  timeout?: number;
  label?: string;
  headers?: Record<string, string>;
}

export type FetchResponseType = "json" | "text";

export async function fetchWithRetry(
  url: string,
  options: FetchOptions & { responseType?: FetchResponseType } = {},
): Promise<unknown> {
  const {
    attempts = MAX_FETCH_ATTEMPTS,
    timeout = FETCH_TIMEOUT_MS,
    responseType = "json",
    label = url,
    headers = {},
  } = options;

  return pRetry(
    async () => {
      const response = await fetch(url, {
        headers: { Accept: "application/json", ...headers },
        signal: AbortSignal.timeout(timeout),
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch ${label} (${response.status} ${response.statusText})`);
      }

      return responseType === "text" ? await response.text() : await response.json();
    },
    { retries: Math.max(0, attempts - 1), minTimeout: 1_000, factor: 2, randomize: false },
  );
}

export function fetchJson(url: string, options: FetchOptions = {}): Promise<unknown> {
  return fetchWithRetry(url, { ...options, responseType: "json" });
}

export function fetchText(url: string, options: FetchOptions = {}): Promise<string> {
  return fetchWithRetry(url, {
    ...options,
    responseType: "text",
    headers: { Accept: "text/plain", ...options.headers },
  }) as Promise<string>;
}
