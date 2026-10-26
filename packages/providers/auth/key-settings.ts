import { API_BASE_URL as nvidiaApiBaseUrl } from "@opendum/providers/auth/nvidia/constants";
import { API_BASE_URL as openRouterApiBaseUrl } from "@opendum/providers/auth/openrouter/constants";
import { API_BASE_URL as zenmuxApiBaseUrl } from "@opendum/providers/auth/zenmux/constants";
import { API_BASE_URL as harborApiBaseUrl } from "@opendum/providers/auth/harbor/constants";
import { API_BASE_URL as hyperApiBaseUrl } from "@opendum/providers/auth/hyper/constants";
import type { KeyProvider } from "@opendum/providers/provider-accounts";

export type ValidationMode = "models" | "chat_probe" | "chat_inference";

export type KeySetting = {
  label: string;
  baseUrl: string;
  validationPath: "/models" | "/chat/completions";
  requireSuccessfulStatus: boolean;
  skipInference?: boolean;
};

export const KEY_SETTINGS: Record<KeyProvider, KeySetting> = {
  nvidia_nim: {
    label: "Nvidia",
    baseUrl: nvidiaApiBaseUrl,
    validationPath: "/chat/completions",
    requireSuccessfulStatus: false,
    skipInference: true,
  },
  openrouter: {
    label: "OpenRouter",
    baseUrl: openRouterApiBaseUrl,
    validationPath: "/models",
    requireSuccessfulStatus: true,
  },
  zenmux: {
    label: "ZenMux",
    baseUrl: zenmuxApiBaseUrl,
    validationPath: "/chat/completions",
    requireSuccessfulStatus: false,
    skipInference: true,
  },
  harbor: {
    label: "Harbor",
    baseUrl: harborApiBaseUrl,
    validationPath: "/models",
    requireSuccessfulStatus: true,
  },
  hyper: {
    label: "Charm",
    baseUrl: hyperApiBaseUrl,
    validationPath: "/chat/completions",
    requireSuccessfulStatus: false,
    skipInference: true,
  },
};

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
    url: `${setting.baseUrl}${setting.validationPath}`,
    method: isPost ? "POST" : "GET",
    headers,
    body,
  };
}

export function keyError(provider: KeyProvider): string {
  return `${KEY_SETTINGS[provider].label} API key is invalid.`;
}

export function relayFailure(provider: KeyProvider, kind: "timeout" | "proxy"): string {
  const label = KEY_SETTINGS[provider].label;
  return kind === "timeout"
    ? `${label} API key validation timed out. Please try again.`
    : `Unable to validate ${label} API key through the proxy. Please try again.`;
}
