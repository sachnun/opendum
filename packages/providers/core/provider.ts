import { Effect } from "effect";
import type { Registry } from "@opendum/models/runtime";
import { ModelName } from "@opendum/providers/core/identity";
import type { UpstreamTransport } from "@opendum/providers/core/http";
import type {
  Provider,
  ProviderAccount,
  ProviderFailure,
  ProviderRequest,
  RefreshedCredentials,
  ProviderCredentialFailure,
} from "@opendum/providers/types";

export type Json = Record<string, unknown>;

export type ProviderOptions = {
  registry: Registry | null;
  transport: UpstreamTransport;
};

export abstract class BaseProvider implements Provider {
  abstract readonly name: string;

  protected readonly registry: Registry | null;
  protected readonly transport: UpstreamTransport;

  constructor(options: ProviderOptions) {
    this.registry = options.registry;
    this.transport = options.transport;
  }

  abstract makeRequest(request: ProviderRequest): Effect.Effect<Response, ProviderFailure>;

  protected readonly authlessMode: boolean = false;

  authless(): boolean {
    return this.authlessMode;
  }

  protected upstream(model: string, provider = this.name): string {
    const value = model.trim();
    const prefix = `${provider}/`;
    const trimmed = value.startsWith(prefix) ? value.slice(prefix.length) : value;
    const resolved = this.registry?.upstream(ModelName.segment(trimmed), provider);
    return resolved || trimmed;
  }

  protected filterParams(body: Json, supported: Set<string>, skip: ReadonlyArray<string> = []): Json {
    const payload: Json = {};
    for (const [key, value] of Object.entries(body)) {
      if (skip.includes(key)) continue;
      if (!supported.has(key)) continue;
      if (value === undefined || value === null) continue;
      payload[key] = value;
    }
    return payload;
  }
}

export abstract class StaticProvider extends BaseProvider {
  declare protected readonly registry: Registry;
}

export abstract class OAuthProvider extends BaseProvider {
  declare protected readonly registry: Registry;
  protected abstract readonly refreshBufferMs: number;
  protected abstract exchange(
    refreshToken: string,
    account: ProviderAccount
  ): Effect.Effect<RefreshedCredentials, ProviderCredentialFailure>;

  refreshBuffer(): number {
    return this.refreshBufferMs;
  }

  refreshCredentials(
    refreshToken: string,
    account: ProviderAccount
  ): Effect.Effect<RefreshedCredentials, ProviderCredentialFailure> {
    return this.exchange(refreshToken, account);
  }
}
