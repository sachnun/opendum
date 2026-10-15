import type { ModelInfo } from "./runtime.ts";

type Json = Record<string, unknown>;

export type OpenAIModelCatalog = {
  models(): string[];
  info(model: string): ModelInfo | null;
};

export class OpenAIModelSerializer {
  constructor(private readonly catalog: OpenAIModelCatalog) {}

  format(): Json[] {
    const data: Json[] = [];
    for (const model of this.catalog.models()) {
      const info = this.catalog.info(model);
      if (!info) continue;
      const item: Json = {
        id: model,
        object: "model",
        providers: info.providers,
      };
      if (info.owner) item.owner = info.owner;
      const reasoning = modelReasoning(info);
      item.reasoning = reasoning;
      if (reasoning && (info.reasoning_effort ?? []).length > 0) {
        item.reasoning_effort = info.reasoning_effort;
      }
      if (info.modalities != null) item.modalities = info.modalities;
      if (info.limit != null && ((info.limit.context ?? 0) > 0 || (info.limit.output ?? 0) > 0)) {
        item.limit = info.limit;
      }
      data.push(item);
    }
    return data;
  }

  isReasoning(model: string): boolean {
    const info = this.catalog.info(model);
    return info ? modelReasoning(info) : false;
  }

  isVision(model: string): boolean {
    const info = this.catalog.info(model);
    return info ? modelVision(info) : false;
  }
}

function modelReasoning(info: ModelInfo): boolean {
  if (info.reasoning == null) return true;
  return info.reasoning;
}

function modelVision(info: ModelInfo): boolean {
  if (info.modalities == null) return true;
  return (info.modalities.input ?? []).includes("image");
}
