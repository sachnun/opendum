export interface ModelModalities {
  input: string[];
  output: string[];
}

export interface ModelCapabilitiesInput {
  reasoning?: boolean;
  modalities?: ModelModalities;
}

export interface EffectiveModelCapabilities {
  reasoning: boolean;
  vision: boolean;
}

export function getEffectiveModelCapabilities(model?: ModelCapabilitiesInput): EffectiveModelCapabilities {
  return {
    reasoning: model?.reasoning === true,
    vision: (model?.modalities?.input ?? []).includes("image"),
  };
}
