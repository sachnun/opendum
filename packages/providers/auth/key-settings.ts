import { COMPAT_SPECS } from "@opendum/providers/compat-specs";
import type { KeyProvider } from "@opendum/providers/provider-accounts";
import {
  API_BASE_URL as deepaiBaseUrl,
  API_KEY_HEADER,
  INSTANCE_HEADER,
} from "@opendum/providers/auth/deepai/constants";

export type KeySetting = {
  label: string;
  validationPath: "/models" | "/chat/completions" | "/theos";
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
  zro: {
    label: "Zro",
    validationPath: "/models",
    requireSuccessfulStatus: true,
  },
  deepai: {
    label: "DeepAI",
    validationPath: "/theos",
    requireSuccessfulStatus: true,
  },
};

const DIRECT_BASE_URLS: Record<string, string> = {
  deepai: deepaiBaseUrl,
};

export function baseUrl(provider: string): string {
  const spec = COMPAT_SPECS.find((item) => item.name === provider);
  if (spec) return spec.baseUrl;
  return DIRECT_BASE_URLS[provider] ?? "";
}

function directHeaders(provider: string, apiKey: string): Record<string, string> | null {
  if (provider !== "deepai") return null;
  return {
    [API_KEY_HEADER]: apiKey,
    [INSTANCE_HEADER]: crypto.randomUUID().replaceAll("-", ""),
  };
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
  const direct = directHeaders(provider, apiKey);
  if (direct) {
    for (const [key, value] of Object.entries(direct)) headers[key] = value;
  }
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
