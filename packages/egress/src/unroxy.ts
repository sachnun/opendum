export type EgressFetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface Egress {
  readonly baseUrl: string;
  fetch: EgressFetcher;
  close(): Promise<void>;
}

export type UnroxyEgressOptions = {
  baseUrl?: string;
};

export const DEFAULT_UNROXY_BASE_URL = "https://unroxy.koyeb.app/";

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "") return DEFAULT_UNROXY_BASE_URL;
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

export class UnroxyEgress implements Egress {
  readonly baseUrl: string;

  constructor(options: UnroxyEgressOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_UNROXY_BASE_URL);
  }

  fetch(input: string | URL, init?: RequestInit): Promise<Response> {
    const target = typeof input === "string" ? input : input.toString();
    return fetch(`${this.baseUrl}${target}`, init);
  }

  async close(): Promise<void> {
    return;
  }
}
