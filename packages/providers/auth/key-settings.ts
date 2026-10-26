import { COMPAT_SPECS } from "@opendum/providers/compat-specs";
import type { KeyProvider } from "@opendum/providers/provider-accounts";

export type KeySetting = {
  label: string;
  validationPath: "/models" | "/chat/completions";
  requireSuccessfulStatus: boolean;
  skipInference?: boolean;
};

export const KEY_SETTINGS: Record<KeyProvider, KeySetting> = {
  nvidia_nim: {
    label: "Nvidia",
    validationPath: "/chat/completions",
    requireSuccessfulStatus: false,
    skipInference: true,
  },
  openrouter: {
    label: "OpenRouter",
    validationPath: "/models",
    requireSuccessfulStatus: true,
  },
  zenmux: {
    label: "ZenMux",
    validationPath: "/chat/completions",
    requireSuccessfulStatus: false,
    skipInference: true,
  },
  harbor: {
    label: "Harbor",
    validationPath: "/models",
    requireSuccessfulStatus: true,
  },
  hyper: {
    label: "Charm",
    validationPath: "/chat/completions",
    requireSuccessfulStatus: false,
    skipInference: true,
  },
};

export function baseUrl(provider: string): string {
  const spec = COMPAT_SPECS.find((item) => item.name === provider);
  return spec?.baseUrl ?? "";
}

export type ValidationRequest = {
  validationModel: string;
  url: string;
  method: "POST" | "GET";
  headers: Record<string, string>;
  body: Record<string, unknown> | undefined;
};

export function validationRequest(
  provider: KeyProvider,
  apiKey: string,
  modelMap: Record<string, string>
): ValidationRequest {
  const setting = KEY_SETTINGS[provider];
  const validationModel = Object.values(modelMap)[0] ?? "";
  const isPost = setting.validationPath === "/chat/completions";
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  let body: Record<string, unknown> | undefined;
  if (isPost) {
    body = setting.skipInference
      ? { model: validationModel, messages: [] }
      : { model: validationModel, messages: [{ role: "user", content: "ping" }], max_tokens: 1, stream: false };
  }
  return {
    validationModel,
    url: `${baseUrl(provider)}${setting.validationPath}`,
    method: isPost ? "POST" : "GET",
    headers,
    body,
  };
}
