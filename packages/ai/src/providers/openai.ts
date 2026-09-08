import type { Provider, ProviderRequestOptions } from "./base.js";
import type { ModelRegistry } from "../registry/registry.js";

export interface OpenAICompatibleOptions {
  name: string;
  baseURL: string;
  supportedParams: Set<string>;
  registry: ModelRegistry;
  trimPrefix?: string;
  extraHeaders?: (account: ProviderRequestOptions["account"]) => Record<string, string>;
}

export class OpenAICompatibleProvider implements Provider {
  public name: string;
  protected baseURL: string;
  protected supportedParams: Set<string>;
  protected registry: ModelRegistry;
  protected trimPrefix?: string;
  protected extraHeadersFn?: (account: ProviderRequestOptions["account"]) => Record<string, string>;

  constructor(options: OpenAICompatibleOptions) {
    this.name = options.name;
    this.baseURL = options.baseURL;
    this.supportedParams = options.supportedParams;
    this.registry = options.registry;
    this.trimPrefix = options.trimPrefix;
    this.extraHeadersFn = options.extraHeaders;
  }

  protected normalizeModel(model: string): string {
    if (this.trimPrefix && model.startsWith(this.trimPrefix)) {
      return model.slice(this.trimPrefix.length);
    }
    return model;
  }

  async makeRequest(options: ProviderRequestOptions): Promise<Response> {
    const { account, credentials, body, stream, signal } = options;
    const rawModel = String(body.model || "");
    const model = this.normalizeModel(rawModel);
    const upstreamModel = this.registry.upstreamModelName(model, this.name);

    const payload: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(body)) {
      if (this.supportedParams.has(key) && value !== undefined && value !== null) {
        payload[key] = value;
      }
    }

    if (this.registry.providerConfigBool(model, this.name, "top_p_deprecated")) {
      delete payload.top_p;
    }

    payload.model = upstreamModel;
    payload.stream = stream;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: stream ? "text/event-stream" : "application/json",
    };

    if (credentials && credentials.trim()) {
      headers.Authorization = `Bearer ${credentials.trim()}`;
    }

    if (this.extraHeadersFn) {
      Object.assign(headers, this.extraHeadersFn(account));
    }

    const endpoint = `${this.baseURL}/chat/completions`;
    return await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal,
    });
  }
}
