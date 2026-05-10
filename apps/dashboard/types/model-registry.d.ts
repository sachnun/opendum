declare module "virtual:opendum-model-registry" {
  import type { ModelInfo } from "../server/lib/proxy/loader";

  export const MODEL_REGISTRY: Record<string, ModelInfo>;
  export const IGNORED_MODELS: Set<string>;
}
