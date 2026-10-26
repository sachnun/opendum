import type { ModelValidationResult } from "@opendum/auth/types";

export function valid(provider: string | null, model: string): ModelValidationResult {
  return {
    valid: true,
    provider,
    model,
    alias: "",
    vision: null,
    error: "",
    param: "",
    code: "",
  };
}

export function invalid(
  provider: string | null,
  model: string,
  error: string,
  param: string,
  code: string
): ModelValidationResult {
  return {
    valid: false,
    provider,
    model,
    alias: "",
    vision: null,
    error,
    param,
    code,
  };
}

export function disabled(provider: string | null, model: string): ModelValidationResult {
  return invalid(
    provider,
    model,
    `Model "${model}" is disabled. Enable it from Web > Models first.`,
    "model",
    "model_disabled"
  );
}
