import type { Provider } from "./base.js";
import type { ModelRegistry } from "../registry/registry.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";
import { ClineProvider } from "./cline.js";
import { QoderProvider } from "./qoder.js";
import { OpencodeProvider } from "./opencode.js";

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

export class ProviderRegistry {
  private providers: Map<string, Provider> = new Map();

  constructor(private registry: ModelRegistry) {
    this.register(new ClineProvider(registry));
    this.register(new QoderProvider(registry));
    this.register(new OpencodeProvider(registry));

    this.register(
      new OpenAICompatibleProvider({
        name: "openrouter",
        baseURL: "https://openrouter.ai/api/v1",
        supportedParams: genericOpenAIParams,
        registry,
        trimPrefix: "openrouter/",
      })
    );

    this.register(
      new OpenAICompatibleProvider({
        name: "nvidia_nim",
        baseURL: "https://integrate.api.nvidia.com/v1",
        supportedParams: genericOpenAIParams,
        registry,
        trimPrefix: "nvidia_nim/",
      })
    );

    this.register(
      new OpenAICompatibleProvider({
        name: "kilo_code",
        baseURL: "https://unroxy.koyeb.app/api.kilo.ai/api/gateway",
        supportedParams: genericOpenAIParams,
        registry,
        trimPrefix: "kilo_code/",
      })
    );

    this.register(
      new OpenAICompatibleProvider({
        name: "harbor",
        baseURL: "https://tokenharbor.ai/v1",
        supportedParams: genericOpenAIParams,
        registry,
        trimPrefix: "harbor/",
      })
    );

    this.register(
      new OpenAICompatibleProvider({
        name: "zenmux",
        baseURL: "https://zenmux.ai/api/v1",
        supportedParams: genericOpenAIParams,
        registry,
        trimPrefix: "zenmux/",
        extraHeaders: () => ({ "x-zenmux-apikey-source": "subscription" }),
      })
    );

    this.register(
      new OpenAICompatibleProvider({
        name: "hyper",
        baseURL: "https://hyper.charm.land/v1",
        supportedParams: genericOpenAIParams,
        registry,
        trimPrefix: "hyper/",
      })
    );
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
