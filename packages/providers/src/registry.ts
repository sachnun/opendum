import type { Registry } from "@opendum/models/runtime";
import type { OpendumRedis } from "@opendum/redis";
import { createTransport, type EgressFetch, type Logger, type MutableTransport } from "#providers/api/http.ts";
import type { FallbackState } from "#providers/lib/fallback.ts";
import type { AuthlessProvider, CredentialRefresher, Provider } from "#providers/model/types.ts";
import type { ProviderDeps, ProviderExtension } from "#providers/extension/types.ts";

export type ProviderRegistryOptions = {
  models: Registry;
  fallback: FallbackState | null;
  redis?: OpendumRedis | null;
  logger?: Logger;
  directFetch?: (url: string, init?: RequestInit) => Promise<Response>;
  extensions?: ProviderExtension[];
};

export class ProviderRegistry {
  readonly transport: MutableTransport;
  private readonly providers = new Map<string, Provider>();

  constructor(options: ProviderRegistryOptions) {
    const direct = options.directFetch ?? ((url: string, init?: RequestInit) => fetch(url, init));
    this.transport = createTransport(direct);

    const deps: ProviderDeps = {
      registry: options.models,
      transport: this.transport,
      fallback: options.fallback,
      redis: options.redis ?? null,
      logger: options.logger,
    };

    for (const extension of options.extensions ?? []) {
      this.register(extension.create(deps));
    }
  }

  private register(provider: Provider): void {
    this.providers.set(provider.name, provider);
  }

  setEgress(egress: EgressFetch | null, ready: boolean): void {
    this.transport.setEgress(egress, ready);
  }

  egressReady(): boolean {
    return this.transport.egressReady();
  }

  get(name: string): Provider | undefined {
    return this.providers.get(name);
  }

  has(name: string): boolean {
    return this.providers.has(name);
  }

  names(): string[] {
    return [...this.providers.keys()].sort((a, b) => a.localeCompare(b));
  }

  refreshableProviderNames(): string[] {
    const names: string[] = [];
    for (const [name, provider] of this.providers) {
      if (isCredentialRefresher(provider)) names.push(name);
    }
    return names.sort((a, b) => a.localeCompare(b));
  }

  isAuthless(name: string): boolean {
    const provider = this.providers.get(name);
    return Boolean(provider && isAuthlessProvider(provider) && provider.authless());
  }
}

export function isAuthlessProvider(provider: Provider): provider is Provider & AuthlessProvider {
  return typeof (provider as Partial<AuthlessProvider>).authless === "function";
}

export function isCredentialRefresher(provider: Provider): provider is Provider & CredentialRefresher {
  return typeof (provider as Partial<CredentialRefresher>).refreshCredentials === "function";
}
