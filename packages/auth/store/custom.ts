import {
  getCustomProvider,
  listCustomProviderModels,
  listCustomProviders,
} from "@opendum/database/queries";

export type CustomProviderRecord = {
  id: string;
  userId: string;
  slug: string;
  name: string;
  baseUrl: string;
  extraHeaders: Record<string, string> | null;
  enabled: boolean;
};

export type CustomProviderModelRecord = {
  id: string;
  providerId: string;
  modelId: string;
  upstream: string | null;
  aliased: boolean;
  authless: boolean;
  minTier: string | null;
  allowedTiers: string[] | null;
  customFlags: {
    responses_api?: boolean;
    top_p_deprecated?: boolean;
    convert_external_images?: boolean;
  } | null;
};

export interface CustomProviderReader {
  listProviders(userId: string): Promise<CustomProviderRecord[]>;
  getProvider(userId: string, slug: string): Promise<CustomProviderRecord | null>;
  listModels(providerId: string): Promise<CustomProviderModelRecord[]>;
}

export function createCustomStore(): CustomProviderReader {
  return {
    listProviders: (userId) => listCustomProviders(userId),
    getProvider: (userId, slug) => getCustomProvider(userId, slug),
    listModels: (providerId) => listCustomProviderModels(providerId),
  };
}
