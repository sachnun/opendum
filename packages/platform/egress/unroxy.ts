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

export const UNROXY_BASE_URL = "https://unroxy.koyeb.app/";

function normalizeUrl(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "") return UNROXY_BASE_URL;
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

export class UnroxyEgress implements Egress {
  readonly baseUrl: string;
  private readonly headersTimeout: number;

  constructor(options: UnroxyEgressOptions = {}) {
    this.baseUrl = normalizeUrl(options.baseUrl ?? UNROXY_BASE_URL);
    this.headersTimeout = options.headersTimeout ?? 0;
  }

  fetch(input: string | URL, init?: RequestInit): Promise<Response> {
    const target = typeof input === "string" ? input : input.toString();
    return this.headersTimeout > 0
      ? fetchTimeout(`${this.baseUrl}${target}`, init, this.headersTimeout)
      : fetch(`${this.baseUrl}${target}`, init);
  }

  async close(): Promise<void> {}
}

function fetchTimeout(
  url: string,
  init: RequestInit | undefined,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new DOMException("upstream headers timed out", "TimeoutError"));
  }, timeoutMs);
  const signal = init?.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
  return fetch(url, { ...init, signal }).finally(() => clearTimeout(timer));
}
