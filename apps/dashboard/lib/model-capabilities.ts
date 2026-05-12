export interface ModelMeta {
  reasoning?: boolean;
  toolCall?: boolean;
  vision?: boolean;
  modalities?: {
    input?: string[];
    output?: string[];
  };
}

export interface EffectiveModelCapabilities {
  reasoning: boolean;
  toolCall: boolean;
  vision: boolean;
}

function defaultEnabledCapability(meta: ModelMeta | undefined, value: boolean | undefined): boolean {
  if (!meta || value === undefined) return true;
  return value;
}

export function getEffectiveModelCapabilities(meta?: ModelMeta): EffectiveModelCapabilities {
  return {
    reasoning: defaultEnabledCapability(meta, meta?.reasoning),
    toolCall: defaultEnabledCapability(meta, meta?.toolCall),
    vision: typeof meta?.vision === "boolean"
      ? meta.vision
      : meta?.modalities?.input?.length
        ? meta.modalities.input.includes("image")
        : true,
  };
}
