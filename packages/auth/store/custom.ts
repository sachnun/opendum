import { Effect } from "effect";
import type { DatabaseFailure } from "@opendum/database";
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
  listProviders(userId: string): Effect.Effect<CustomProviderRecord[], DatabaseFailure>;
  getProvider(userId: string, slug: string): Effect.Effect<CustomProviderRecord | null, DatabaseFailure>;
  listModels(providerId: string): Effect.Effect<CustomProviderModelRecord[], DatabaseFailure>;
}

export function createCustomStore(): CustomProviderReader {
  return {
    listProviders: (userId) => listCustomProviders(userId),
    getProvider: (userId, slug) => getCustomProvider(userId, slug),
    listModels: (providerId) => listCustomProviderModels(providerId),
  };
}
