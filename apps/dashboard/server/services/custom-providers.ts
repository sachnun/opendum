import { and, count, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { db } from "../lib/db";
import { customProvider, customProviderModel, providerAccount } from "../lib/db/schema";
import { encrypt, hashString } from "../lib/encryption";
import { fetchInternalProvider, InternalRelayNotConfiguredError } from "../lib/proxy/internal-relay";
import { PROVIDER_ACCOUNT_KEYS } from "./account-providers";
import type { ActionResult } from "../utils/api";

const SLUG_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const API_KEY_ACCOUNT_EXPIRY = new Date("2100-01-01T00:00:00.000Z");
const INTERNAL_RELAY_ERROR_HEADER = "X-Opendum-Internal-Relay-Error";
const VALIDATION_TIMEOUT_MS = 15000;

export const customModelInputSchema = z.object({
  modelId: z.string().trim().min(1).max(120),
  upstream: z.string().trim().max(200).optional(),
  authless: z.boolean().optional(),
  minTier: z.string().trim().max(60).optional(),
  allowedTiers: z.array(z.string().trim().min(1)).optional(),
  meta: z
    .object({
      reasoning: z.boolean().optional(),
      toolCall: z.boolean().optional(),
      vision: z.boolean().optional(),
    })
    .optional(),
  customFlags: z
    .object({
      responses_api: z.boolean().optional(),
      top_p_deprecated: z.boolean().optional(),
      convert_external_images: z.boolean().optional(),
    })
    .optional(),
});

export const createCustomProviderSchema = z.object({
  slug: z.string().trim().toLowerCase().regex(SLUG_PATTERN, "Slug must match [a-z][a-z0-9_-]{0,31}"),
  name: z.string().trim().min(1).max(120),
  baseUrl: z.string().trim().min(1).max(500),
  extraHeaders: z.record(z.string(), z.string()).optional(),
});

export const updateCustomProviderSchema = z.object({
  slug: z.string().trim().toLowerCase().regex(SLUG_PATTERN, "Invalid slug"),
  name: z.string().trim().min(1).max(120).optional(),
  baseUrl: z.string().trim().min(1).max(500).optional(),
  extraHeaders: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().optional(),
});

export const deleteCustomProviderSchema = z.object({
  slug: z.string().trim().toLowerCase().regex(SLUG_PATTERN, "Invalid slug"),
});

export const connectCustomProviderAccountSchema = z.object({
  slug: z.string().trim().toLowerCase().regex(SLUG_PATTERN, "Invalid slug"),
  token: z.string().trim().min(1),
  name: z.string().trim().max(120).optional(),
});

export const upsertCustomModelsSchema = z.object({
  slug: z.string().trim().toLowerCase().regex(SLUG_PATTERN, "Invalid slug"),
  models: z.array(customModelInputSchema).min(1).max(500),
});

export const deleteCustomModelSchema = z.object({
  slug: z.string().trim().toLowerCase().regex(SLUG_PATTERN, "Invalid slug"),
  modelId: z.string().trim().min(1).max(120),
});

export const syncCustomModelsSchema = z.object({
  slug: z.string().trim().toLowerCase().regex(SLUG_PATTERN, "Invalid slug"),
});

function isProbablyPrivateTarget(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return true;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return true;
  const host = parsed.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;
  const literal = host.replace(/^\[|\]$/g, "");
  if (/^\d+\.\d+\.\d+\.\d+$/.test(literal)) {
    const parts = literal.split(".").map(Number);
    if (parts[0] === 10 || parts[0] === 127 || parts[0] === 169 && parts[1] === 254 || parts[0] === 192 && parts[1] === 168 || parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31 || parts[0] === 0 || parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
  }
  if (literal.includes(":")) {
    const normalized = literal.toLowerCase();
    if (normalized === "::1" || normalized.startsWith("fe80:") || normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  }
  return false;
}

function privateTargetsAllowed(): boolean {
  const value = process.env.ALLOW_PRIVATE_CUSTOM_PROVIDERS?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

function normalizeBaseUrl(raw: string): string | null {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return null;
  if (isProbablyPrivateTarget(trimmed) && !privateTargetsAllowed()) return null;
  return trimmed;
}

async function ownedProvider(userId: string, slug: string) {
  const rows = await db
    .select()
    .from(customProvider)
    .where(and(eq(customProvider.userId, userId), eq(customProvider.slug, slug)))
    .limit(1);
  return rows[0] ?? null;
}

export async function listCustomProviders(userId: string) {
  const providers = await db.select().from(customProvider).where(eq(customProvider.userId, userId)).orderBy(customProvider.createdAt);
  const models = await db.select().from(customProviderModel).where(inArray(customProviderModel.providerId, providers.map((row) => row.id)));
  const accountCounts = await db
    .select({ provider: providerAccount.provider, value: count() })
    .from(providerAccount)
    .where(eq(providerAccount.userId, userId))
    .groupBy(providerAccount.provider);
  const countByProvider = new Map(accountCounts.map((row) => [row.provider, row.value]));
  return {
    success: true as const,
    data: providers.map((provider) => ({
      ...provider,
      accountCount: countByProvider.get(provider.slug) ?? 0,
      models: models
        .filter((row) => row.providerId === provider.id)
        .sort((a, b) => a.modelId.localeCompare(b.modelId)),
    })),
  };
}

export async function createCustomProvider(userId: string, input: z.infer<typeof createCustomProviderSchema>): Promise<ActionResult<{ id: string; slug: string }>> {
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  if (!baseUrl) return { success: false, error: "baseUrl is invalid or targets a private network address (set ALLOW_PRIVATE_CUSTOM_PROVIDERS=true to allow)." };
  if (PROVIDER_ACCOUNT_KEYS.includes(input.slug as (typeof PROVIDER_ACCOUNT_KEYS)[number])) return { success: false, error: `Slug "${input.slug}" is reserved for a built-in provider.` };
  const existing = await ownedProvider(userId, input.slug);
  if (existing) return { success: false, error: `Custom provider "${input.slug}" already exists.` };
  const rows = await db
    .insert(customProvider)
    .values({
      userId,
      slug: input.slug,
      name: input.name,
      baseUrl,
      extraHeaders: input.extraHeaders ?? {},
      enabled: true,
    })
    .returning({ id: customProvider.id, slug: customProvider.slug });
  const created = rows[0];
  return { success: true, data: { id: created.id, slug: created.slug } };
}

export async function updateCustomProvider(userId: string, input: z.infer<typeof updateCustomProviderSchema>): Promise<ActionResult> {
  const provider = await ownedProvider(userId, input.slug);
  if (!provider) return { success: false, error: `Custom provider "${input.slug}" not found.` };
  const baseUrl = input.baseUrl == null ? undefined : normalizeBaseUrl(input.baseUrl);
  if (input.baseUrl != null && !baseUrl) return { success: false, error: "baseUrl is invalid or targets a private network address (set ALLOW_PRIVATE_CUSTOM_PROVIDERS=true to allow)." };
  await db
    .update(customProvider)
    .set({
      ...(input.name != null ? { name: input.name } : {}),
      ...(baseUrl != null ? { baseUrl } : {}),
      ...(input.extraHeaders != null ? { extraHeaders: input.extraHeaders } : {}),
      ...(input.enabled != null ? { enabled: input.enabled } : {}),
    })
    .where(and(eq(customProvider.userId, userId), eq(customProvider.slug, input.slug)));
  return { success: true };
}

export async function deleteCustomProvider(userId: string, slug: string): Promise<ActionResult> {
  const provider = await ownedProvider(userId, slug);
  if (!provider) return { success: false, error: `Custom provider "${slug}" not found.` };
  await db.delete(providerAccount).where(and(eq(providerAccount.userId, userId), eq(providerAccount.provider, slug)));
  await db.delete(customProvider).where(eq(customProvider.id, provider.id));
  return { success: true };
}

export async function upsertCustomModels(userId: string, slug: string, models: z.infer<typeof customModelInputSchema>[]): Promise<ActionResult<{ added: number }>> {
  const provider = await ownedProvider(userId, slug);
  if (!provider) return { success: false, error: `Custom provider "${slug}" not found.` };
  const seen = new Set<string>();
  let added = 0;
  for (const input of models) {
    if (seen.has(input.modelId)) continue;
    seen.add(input.modelId);
    const result = await db
      .insert(customProviderModel)
      .values({
        providerId: provider.id,
        modelId: input.modelId,
        upstream: input.upstream ?? input.modelId,
        authless: input.authless ?? false,
        minTier: input.minTier ?? null,
        allowedTiers: input.allowedTiers ?? null,
        meta: input.meta ?? {},
        customFlags: input.customFlags ?? {},
      })
      .onConflictDoNothing({ target: [customProviderModel.providerId, customProviderModel.modelId] });
    added += result.rowCount ?? 0;
  }
  return { success: true, data: { added } };
}

export async function deleteCustomModel(userId: string, slug: string, modelId: string): Promise<ActionResult> {
  const provider = await ownedProvider(userId, slug);
  if (!provider) return { success: false, error: `Custom provider "${slug}" not found.` };
  await db
    .delete(customProviderModel)
    .where(and(eq(customProviderModel.providerId, provider.id), eq(customProviderModel.modelId, modelId)));
  return { success: true };
}

async function syncFromUpstream(baseUrl: string): Promise<ActionResult<{ discovered: number; total: number }>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), VALIDATION_TIMEOUT_MS);
  try {
    const response = await fetchInternalProvider(`${baseUrl}/models`, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (response.headers.get(INTERNAL_RELAY_ERROR_HEADER) === "1") return { success: false, error: "Unable to reach the provider through the proxy." };
    if (!response.ok) return { success: false, error: `Provider /models endpoint returned HTTP ${response.status}.` };
    const payload = (await response.json().catch(() => null)) as { data?: { id?: string }[] } | { id?: string }[] | null;
    if (payload == null) return { success: false, error: "Provider /models response was not valid JSON." };
    const ids = (Array.isArray(payload) ? payload : payload.data ?? [])
      .map((item) => item.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    if (ids.length === 0) return { success: false, error: "Provider /models returned no model ids." };
    return { success: true, data: { ids } };
  } catch (error) {
    if (error instanceof InternalRelayNotConfiguredError) return { success: false, error: "Proxy URL is required to reach external providers." };
    if (error instanceof Error && error.name === "AbortError") return { success: false, error: "Provider /models request timed out." };
    return { success: false, error: "Unable to reach the provider /models endpoint." };
  } finally {
    clearTimeout(timeout);
  }
}

export async function syncCustomModels(userId: string, slug: string): Promise<ActionResult<{ added: number; discovered: number }>> {
  const provider = await ownedProvider(userId, slug);
  if (!provider) return { success: false, error: `Custom provider "${slug}" not found.` };
  const fetched = await syncFromUpstream(provider.baseUrl);
  if (!fetched.success) return fetched;
  const upserted = await upsertCustomModels(userId, slug, fetched.data.ids.map((modelId) => ({ modelId })));
  if (!upserted.success) return upserted;
  return { success: true, data: { added: upserted.data.added, discovered: fetched.data.ids.length } };
}

export async function connectCustomProviderAccount(userId: string, slug: string, apiKey: string, name?: string): Promise<ActionResult<{ isUpdate: boolean }>> {
  const provider = await ownedProvider(userId, slug);
  if (!provider) return { success: false, error: `Custom provider "${slug}" not found.` };
  const normalizedKey = apiKey.trim();
  if (!normalizedKey) return { success: false, error: "API key is required." };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), VALIDATION_TIMEOUT_MS);
  try {
    const response = await fetchInternalProvider(`${provider.baseUrl}/models`, {
      method: "GET",
      headers: { Authorization: `Bearer ${normalizedKey}`, Accept: "application/json" },
      signal: controller.signal,
    });
    if (response.headers.get(INTERNAL_RELAY_ERROR_HEADER) === "1") return { success: false, error: "Unable to validate the API key through the proxy." };
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      if (response.status === 401 || response.status === 403 || /unauthorized|invalid api key|invalid key|authentication/i.test(text)) return { success: false, error: "API key is invalid." };
      return { success: false, error: `Unable to validate the API key right now (HTTP ${response.status}).` };
    }
  } catch (error) {
    if (error instanceof InternalRelayNotConfiguredError) return { success: false, error: "Proxy URL is required to validate external provider API keys." };
    if (error instanceof Error && error.name === "AbortError") return { success: false, error: "API key validation timed out." };
    return { success: false, error: "Unable to validate the API key. Please check your network and try again." };
  } finally {
    clearTimeout(timeout);
  }

  const identifier = `custom-${slug}-${hashString(normalizedKey).slice(0, 16)}`;
  const normalizedName = name?.trim();
  const existing = await db
    .select({ id: providerAccount.id, name: providerAccount.name })
    .from(providerAccount)
    .where(and(eq(providerAccount.userId, userId), eq(providerAccount.provider, slug), eq(providerAccount.email, identifier)))
    .limit(1);
  const existingAccount = existing[0];
  let displayName = normalizedName;
  if (!displayName) {
    displayName = existingAccount?.name;
  }
  if (!displayName) {
    const counts = await db.select({ value: count() }).from(providerAccount).where(and(eq(providerAccount.userId, userId), eq(providerAccount.provider, slug)));
    displayName = `${provider.name} ${(counts[0]?.value ?? 0) + 1}`;
  }
  if (existingAccount) {
    await db
      .update(providerAccount)
      .set({
        accessToken: encrypt(normalizedKey),
        refreshToken: encrypt(normalizedKey),
        expiresAt: API_KEY_ACCOUNT_EXPIRY,
        isActive: true,
        disabledUntil: null,
        ...(normalizedName ? { name: normalizedName } : {}),
      })
      .where(eq(providerAccount.id, existingAccount.id));
    return { success: true, data: { isUpdate: true } };
  }
  await db.insert(providerAccount).values({
    userId,
    provider: slug,
    name: displayName,
    accessToken: encrypt(normalizedKey),
    refreshToken: encrypt(normalizedKey),
    expiresAt: API_KEY_ACCOUNT_EXPIRY,
    email: identifier,
    isActive: true,
  });
  return { success: true, data: { isUpdate: false } };
}
