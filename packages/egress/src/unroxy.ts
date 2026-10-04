import { ProxyAgent, fetch as undiciFetch, type RequestInit } from "undici";

export type EgressRequestOptions = {
  region?: string;
};

export type EgressFetcher = (
  input: string | URL,
  init?: RequestInit,
  options?: EgressRequestOptions
) => Promise<Response>;

export interface Egress {
  readonly preferred: string;
  fetch: EgressFetcher;
  dispatcher(region?: string): ProxyAgent;
  close(): Promise<void>;
}

export type UnroxyEgressOptions = {
  url: string;
  preferred: string;
};

export class UnroxyEgress implements Egress {
  readonly preferred: string;
  private readonly baseUrl: URL;
  private readonly agents = new Map<string, ProxyAgent>();

  constructor(options: UnroxyEgressOptions) {
    this.baseUrl = new URL(options.url);
    this.preferred = options.preferred.trim().toUpperCase() || "US";
  }

  dispatcher(region?: string): ProxyAgent {
    const key = (region ?? this.preferred).trim().toUpperCase() || this.preferred;
    const cached = this.agents.get(key);
    if (cached) return cached;
    const url = new URL(this.baseUrl);
    url.username = key.toLowerCase();
    url.password = "";
    const agent = new ProxyAgent(url.toString());
    this.agents.set(key, agent);
    return agent;
  }

  fetch(
    input: string | URL,
    init: RequestInit = {},
    options: EgressRequestOptions = {}
  ): Promise<Response> {
    return undiciFetch(input, {
      ...init,
      dispatcher: this.dispatcher(options.region),
    }) as unknown as Promise<Response>;
  }

  async close(): Promise<void> {
    const agents = [...this.agents.values()];
    this.agents.clear();
    await Promise.all(agents.map((agent) => agent.close()));
  }
}
