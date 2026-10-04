import {
  BY_KEY,
  DEVICE_PROVIDER_KEYS,
  OAUTH_PROVIDER_KEYS,
  PROVIDER_ACCOUNT_DEFINITIONS,
  type DeviceProviderKey,
  type OAuthProviderKey,
  type ProviderAccountKey,
  type ProviderAuthMethodKey,
} from "./provider-accounts";

export type Provider = string;

export type FlowType = "oauth_redirect" | "device_code" | "chatgpt_session" | "api_key" | "api_key_with_account_id";

export type MethodKey = FlowType;

export interface ProviderMethod {
  key: MethodKey;
  flow?: FlowType;
  name: string;
  tag?: string;
  disabled?: boolean;
}

export interface ProviderConfig {
  name: string;
  methods: ProviderMethod[];
  apiKeyPortalUrl?: string;
  apiKeyPlaceholder?: string;
  accountIdPlaceholder?: string;
  accountIdLabel?: string;
}

export const providerMethodLabels: Record<ProviderAuthMethodKey, { name: string; disabled?: boolean }> = {
  oauth_redirect: { name: "Browser OAuth" },
  device_code: { name: "Device Code" },
  api_key: { name: "API Key" },
  api_key_with_account_id: { name: "API Token" },
  chatgpt_session: { name: "ChatGPT Session", disabled: true },
};

export const providerConfigs: Record<Provider, ProviderConfig> = Object.fromEntries(
  PROVIDER_ACCOUNT_DEFINITIONS.map((definition) => [
    definition.key,
    {
      name: definition.label,
      methods: definition.authMethods.map((methodKey) => {
        const method = providerMethodLabels[methodKey];
        return { key: methodKey, name: method.name, disabled: method.disabled };
      }),
      ...(definition.apiKeyPortalUrl ? { apiKeyPortalUrl: definition.apiKeyPortalUrl } : {}),
      ...(definition.apiKeyPlaceholder ? { apiKeyPlaceholder: definition.apiKeyPlaceholder } : {}),
      ...(definition.accountIdPlaceholder ? { accountIdPlaceholder: definition.accountIdPlaceholder } : {}),
      ...(definition.accountIdLabel ? { accountIdLabel: definition.accountIdLabel } : {}),
    },
  ])
) as Record<Provider, ProviderConfig>;

export const chatgptSessionPlaceholder = `{
  "WARNING_BANNER": "!!!!!!!!!!!!!!!!!!!! DO NOT SHARE ANY PART OF THE INFORMATION YOU SEE HERE. THIS INFORMATION IS SENSITIVE AND CAN GRANT ACCESS TO YOUR ACCOUNT. !!!!!!!!!!!!!!!!!!!!",
  "user": {
    "email": "you@example.com"
  },
  "expires": "2026-08-16T22:42:05.747Z",
  "account": {
    "id": "b975c0c5-b667-4aa8-ac89-ce4ec41c6357",
    "planType": "free"
  },
  "accessToken": "eyJ...",
  "authProvider": "openai",
  "sessionToken": "eyJ..."
}`;

export const providerOptions: Provider[] = [...PROVIDER_ACCOUNT_DEFINITIONS]
  .sort((a, b) => (a.displayOrder ?? Number.MAX_SAFE_INTEGER) - (b.displayOrder ?? Number.MAX_SAFE_INTEGER))
  .map((definition) => definition.key);

export function isOAuthProvider(provider: Provider): provider is OAuthProviderKey {
  return (OAUTH_PROVIDER_KEYS as readonly Provider[]).includes(provider);
}

export function isDeviceProvider(provider: Provider): provider is DeviceProviderKey {
  return (DEVICE_PROVIDER_KEYS as readonly Provider[]).includes(provider);
}

export function callbackPlaceholder(providerKey: Provider | null) {
  if (providerKey && providerKey in BY_KEY) {
    const definition = BY_KEY[providerKey as ProviderAccountKey];
    if (definition.callbackPlaceholder) return definition.callbackPlaceholder;
  }
  return "http://localhost:1/oauth2callback?code=...";
}
