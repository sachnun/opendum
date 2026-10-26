import type { Registry } from "@opendum/models/runtime";
import type { OpendumRedis } from "@opendum/core/redis";
import { Transport, type EgressFetch, type Logger } from "@opendum/providers/core/http";
import type { FallbackState } from "@opendum/providers/core/fallback";
import { CompatProvider, SUPPORTED_HARBOR, SUPPORTED_HYPER, SUPPORTED_KILO, SUPPORTED_NVIDIA, SUPPORTED_OPENROUTER, SUPPORTED_ZENMUX } from "@opendum/providers/upstreams/compat/index";
import { OpencodeProvider } from "@opendum/providers/upstreams/opencode/index";
import { ClineProvider } from "@opendum/providers/upstreams/cline/index";
import { WorkbuddyProvider } from "@opendum/providers/upstreams/workbuddy/index";
import { PerchProvider } from "@opendum/providers/upstreams/perch/index";
import { CodexProvider } from "@opendum/providers/upstreams/codex/index";
import { KiroProvider } from "@opendum/providers/upstreams/kiro/index";
import { AntigravityProvider } from "@opendum/providers/upstreams/antigravity/index";
import { WorkersAiProvider } from "@opendum/providers/upstreams/workers-ai/index";
import type { AuthlessProvider, CredentialRefresher, Provider } from "@opendum/providers/types";

export type ProviderRegistryOptions = {
  models: Registry;
  fallback: FallbackState | null;
  redis?: OpendumRedis | null;
  logger?: Logger;
  directFetch?: (url: string, init?: RequestInit) => Promise<Response>;
};

export class ProviderRegistry {
  readonly transport: Transport;
  private readonly providers = new Map<string, Provider>();

  constructor(options: ProviderRegistryOptions) {
    const direct = options.directFetch ?? ((url, init) => fetch(url, init));
    this.transport = new Transport(direct);
    const common = {
      registry: options.models,
      transport: this.transport,
      fallback: options.fallback,
      logger: options.logger,
    };

    this.register(new OpencodeProvider(common));
    this.register(new ClineProvider({ registry: options.models, transport: this.transport }));
    this.register(new WorkbuddyProvider({ registry: options.models, transport: this.transport }));
    this.register(new PerchProvider({ registry: options.models, transport: this.transport }));
    this.register(new KiroProvider({ registry: options.models, transport: this.transport }));
    this.register(
      new AntigravityProvider({
        registry: options.models,
        transport: this.transport,
        redis: options.redis ?? null,
      })
    );
    this.register(
      new CodexProvider({
        registry: options.models,
        transport: this.transport,
        redis: options.redis ?? null,
      })
    );
    this.register(new WorkersAiProvider({ registry: options.models, transport: this.transport }));
    this.register(
      new CompatProvider({
        name: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        supportedParams: SUPPORTED_OPENROUTER,
        trimPrefix: "openrouter/",
        ...common,
      })
    );
    this.register(
      new CompatProvider({
        name: "nvidia_nim",
        baseUrl: "https://integrate.api.nvidia.com/v1",
        supportedParams: SUPPORTED_NVIDIA,
        trimPrefix: "nvidia_nim/",
        ...common,
      })
    );
    this.register(
      new CompatProvider({
        name: "kilo_code",
        baseUrl: "https://api.kilo.ai/api/gateway",
        fallbackBaseUrl: "https://unroxy.koyeb.app/api.kilo.ai/api/gateway",
        supportedParams: SUPPORTED_KILO,
        trimPrefix: "kilo_code/",
        ...common,
      })
    );
    this.register(
      new CompatProvider({
        name: "harbor",
        baseUrl: "https://tokenharbor.ai/v1",
        supportedParams: SUPPORTED_HARBOR,
        trimPrefix: "harbor/",
        ...common,
      })
    );
    this.register(
      new CompatProvider({
        name: "zenmux",
        baseUrl: "https://zenmux.ai/api/v1",
        supportedParams: SUPPORTED_ZENMUX,
        trimPrefix: "zenmux/",
        ...common,
      })
    );
    this.register(
      new CompatProvider({
        name: "hyper",
        baseUrl: "https://hyper.charm.land/v1",
        supportedParams: SUPPORTED_HYPER,
        trimPrefix: "hyper/",
        ...common,
      })
    );
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
      if (isRefresher(provider)) names.push(name);
    }
    return names.sort((a, b) => a.localeCompare(b));
  }

  isAuthless(name: string): boolean {
    const provider = this.providers.get(name);
    return Boolean(provider && isAuthless(provider) && provider.authless());
  }
}

export function isAuthless(provider: Provider): provider is Provider & AuthlessProvider {
  return typeof (provider as Partial<AuthlessProvider>).authless === "function";
}

export function isRefresher(provider: Provider): provider is Provider & CredentialRefresher {
  return typeof (provider as Partial<CredentialRefresher>).refreshCredentials === "function";
}
