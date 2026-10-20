export type EgressFetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface Egress {
  readonly baseUrl: string;
  fetch: EgressFetcher;
  close(): Promise<void>;
}

export type UnroxyEgressOptions = {
  baseUrl?: string;
  headersTimeout?: number;
};

export const DEFAULT_UNROXY_BASE_URL = "https://unroxy.koyeb.app/";

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "") return DEFAULT_UNROXY_BASE_URL;
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

export class UnroxyEgress implements Egress {
  readonly baseUrl: string;
  private readonly headersTimeout: number;

  constructor(options: UnroxyEgressOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_UNROXY_BASE_URL);
    this.headersTimeout = options.headersTimeout ?? 0;
  }

  fetch(input: string | URL, init?: RequestInit): Promise<Response> {
    const target = typeof input === "string" ? input : input.toString();
    return this.headersTimeout > 0
      ? fetchWithHeadersTimeout(`${this.baseUrl}${target}`, init, this.headersTimeout)
      : fetch(`${this.baseUrl}${target}`, init);
  }

  async close(): Promise<void> {
    return;
  }
}

/**
 * Aborts only the wait for response headers, so a slow body keeps streaming
 * after the timeout has been cleared.
 */
async function fetchWithHeadersTimeout(
  url: string,
  init: RequestInit | undefined,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new DOMException("upstream headers timed out", "TimeoutError"));
  }, timeoutMs);
  const signal = init?.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
  try {
    return await fetch(url, { ...init, signal });
  } finally {
    clearTimeout(timer);
  }
}
