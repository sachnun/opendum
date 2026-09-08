import { readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Provider } from "./base.js";
import type { ModelRegistry } from "../registry/registry.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";

const genericOpenAIParams = new Set([
  "model",
  "messages",
  "temperature",
  "top_p",
  "max_tokens",
  "max_completion_tokens",
  "stream",
  "stream_options",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "presence_penalty",
  "frequency_penalty",
  "n",
  "stop",
  "seed",
  "response_format",
  "reasoning",
  "reasoning_effort",
]);

const IGNORED_FILES = new Set([
  "base.ts",
  "base.js",
  "base.d.ts",
  "registry.ts",
  "registry.js",
  "registry.d.ts",
  "openai-compatible.ts",
  "openai-compatible.js",
  "openai-compatible.d.ts",
]);

export class ProviderRegistry {
  private providers: Map<string, Provider> = new Map();

  constructor(private registry: ModelRegistry) {
    this.registerBuiltInGenericProviders();
  }

  private registerBuiltInGenericProviders(): void {
    const genericProviders: Array<{
      name: string;
      baseURL: string;
      trimPrefix?: string;
      extraHeaders?: () => Record<string, string>;
    }> = [
      {
        name: "openrouter",
        baseURL: "https://openrouter.ai/api/v1",
        trimPrefix: "openrouter/",
      },
      {
        name: "nvidia_nim",
        baseURL: "https://integrate.api.nvidia.com/v1",
        trimPrefix: "nvidia_nim/",
      },
      {
        name: "kilo_code",
        baseURL: "https://unroxy.koyeb.app/api.kilo.ai/api/gateway",
        trimPrefix: "kilo_code/",
      },
      {
        name: "harbor",
        baseURL: "https://tokenharbor.ai/v1",
        trimPrefix: "harbor/",
      },
      {
        name: "zenmux",
        baseURL: "https://zenmux.ai/api/v1",
        trimPrefix: "zenmux/",
        extraHeaders: () => ({ "x-zenmux-apikey-source": "subscription" }),
      },
      {
        name: "hyper",
        baseURL: "https://hyper.charm.land/v1",
        trimPrefix: "hyper/",
      },
    ];

    for (const p of genericProviders) {
      this.register(
        new OpenAICompatibleProvider({
          name: p.name,
          baseURL: p.baseURL,
          supportedParams: genericOpenAIParams,
          registry: this.registry,
          trimPrefix: p.trimPrefix,
          extraHeaders: p.extraHeaders,
        })
      );
    }
  }

  /**
   * Nuxt-style Auto-Discovery:
   * Scan folder providers tanpa butuh index.ts sama sekali:
   * 1. Direct file: `providers/<name>.ts`
   * 2. Subdirectory: `providers/<name>/client.ts` atau `providers/<name>/<name>.ts`
   */
  public async autoDiscover(providersDir?: string): Promise<void> {
    const baseDir = providersDir || dirname(fileURLToPath(import.meta.url));
    const entries = readdirSync(baseDir, { withFileTypes: true });

    for (const entry of entries) {
      let targetFile: string | null = null;

      if (entry.isFile()) {
        if (
          (entry.name.endsWith(".ts") || entry.name.endsWith(".js")) &&
          !entry.name.endsWith(".d.ts") &&
          !IGNORED_FILES.has(entry.name)
        ) {
          targetFile = resolve(baseDir, entry.name);
        }
      } else if (entry.isDirectory()) {
        const subfolder = resolve(baseDir, entry.name);
        const subFiles = readdirSync(subfolder);
        // Prioritas kandidat: client.ts, <nama-folder>.ts, index.ts
        const candidates = [
          "client.ts",
          "client.js",
          `${entry.name}.ts`,
          `${entry.name}.js`,
          "index.ts",
          "index.js",
        ];

        for (const candidate of candidates) {
          if (subFiles.includes(candidate)) {
            targetFile = resolve(subfolder, candidate);
            break;
          }
        }
      }

      if (!targetFile) continue;

      try {
        const mod = await import(pathToFileURL(targetFile).href);
        let instantiated: Provider | null = null;

        if (typeof mod.default === "function") {
          try {
            instantiated = mod.default(this.registry);
          } catch {
            instantiated = new mod.default(this.registry);
          }
        } else {
          for (const key of Object.keys(mod)) {
            if (key.endsWith("Provider") && typeof mod[key] === "function") {
              try {
                instantiated = new mod[key](this.registry);
                break;
              } catch {
                // ignore
              }
            }
          }
        }

        if (instantiated && typeof instantiated.makeRequest === "function") {
          this.register(instantiated);
        }
      } catch (err) {
        console.warn(`Failed to auto-load provider from ${targetFile}:`, err);
      }
    }
  }

  public register(provider: Provider): void {
    this.providers.set(provider.name, provider);
  }

  public get(name: string): Provider | undefined {
    return this.providers.get(name);
  }

  public getNames(): string[] {
    return Array.from(this.providers.keys()).sort();
  }
}
