import { Result } from "effect";
import { Effect } from "effect";
import { and, count, eq, inArray } from "drizzle-orm";

import { db, customProvider, customProviderModel, providerAccount } from "@opendum/database";
import { stripParams } from "@opendum/models/clean-key";
import { idMap } from "@opendum/models/model-store";
import { decrypt, encrypt, hashString } from "@opendum/api/web/lib/encryption";
import { fetchExternalEffect } from "@opendum/api/web/lib/external";
import { fromPromise } from "@opendum/api/web/lib/task";
import { internal } from "@opendum/api/web/errors";
import type { CustomCreateInput, CustomModelInput, ModelsPreviewInput, CustomUpdateInput } from "@opendum/providers/contract";
import { PROVIDER_ACCOUNT_KEYS } from "@opendum/api/web/services/account-providers";

const KEY_ACCOUNT_EXPIRY = new Date("2100-01-01T00:00:00.000Z");
const RELAY_ERROR_HEADER = "X-Opendum-Internal-Relay-Error";
const VALIDATION_TIMEOUT_MS = 15000;

function privateTarget(raw: string): boolean {
  const parsed = Result.try({ try: () => new URL(raw), catch: () => null });
  if (Result.isFailure(parsed)) return true;
  const target = parsed.success;
  if (target.protocol !== "http:" && target.protocol !== "https:") return true;
  const host = target.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;
  const literal = host.replace(/^\[|\]$/g, "");
  if (/^\d+\.\d+\.\d+\.\d+$/.test(literal)) {
    const [a = 0, b = 0] = literal.split(".").map(Number);
    if (a === 10 || a === 127 || (a === 169 && b === 254) || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || a === 0 || (a === 100 && b >= 64 && b <= 127)) return true;
  }
  if (literal.includes(":")) {
    const normalized = literal.toLowerCase();
    if (normalized === "::1" || normalized.startsWith("fe80:") || normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  }
  return false;
}

function normalizeUrl(raw: string): string | null {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return null;
  if (privateTarget(trimmed)) return null;
  return trimmed;
}

const ownedProvider = Effect.fn("customProviders.ownedProvider")(function* (
  userId: string,
  slug: string
) {
  const rows = yield* fromPromise(
    () =>
      db
        .select()
        .from(customProvider)
        .where(and(eq(customProvider.userId, userId), eq(customProvider.slug, slug)))
        .limit(1),
    "Failed to load custom provider"
  );
  return rows[0] ?? null;
});

const storedAccountKey = Effect.fn("customProviders.storedAccountKey")(function* (
  userId: string,
  slug: string
) {
  const rows = yield* fromPromise(
    () =>
      db
        .select({ accessToken: providerAccount.accessToken })
        .from(providerAccount)
        .where(and(eq(providerAccount.userId, userId), eq(providerAccount.provider, slug), eq(providerAccount.isActive, true)))
        .limit(1),
    "Failed to load custom provider account"
  );
  const accessToken = rows[0]?.accessToken;
  if (!accessToken) return null;
  return yield* Effect.try({
    try: () => decrypt(accessToken),
    catch: () => internal("Failed to decrypt custom provider key"),
  }).pipe(Effect.catch(() => Effect.succeed(null)));
});

export const listCustomProviders = Effect.fn("customProviders.list")(function* (userId: string) {
  const providers = yield* fromPromise(
    () =>
      db
        .select()
        .from(customProvider)
        .where(eq(customProvider.userId, userId))
        .orderBy(customProvider.createdAt),
    "Failed to load custom providers"
  );
  const models = yield* fromPromise(
    () =>
      db
        .select()
        .from(customProviderModel)
        .where(inArray(customProviderModel.providerId, providers.map((row) => row.id))),
    "Failed to load custom provider models"
  );
  const accountCounts = yield* fromPromise(
    () =>
      db
        .select({ provider: providerAccount.provider, value: count() })
        .from(providerAccount)
        .where(eq(providerAccount.userId, userId))
        .groupBy(providerAccount.provider),
    "Failed to count custom provider accounts"
  );
  const countByProvider = new Map(accountCounts.map((row) => [row.provider, row.value]));
  return providers.map((provider) => ({
    ...provider,
    accountCount: countByProvider.get(provider.slug) ?? 0,
    models: models
      .filter((row) => row.providerId === provider.id)
      .sort((a, b) => a.modelId.localeCompare(b.modelId)),
  }));
});

export const customProviderModels = Effect.fn("customProviders.models")(function* (
  userId: string,
  slug: string
) {
  const provider = yield* ownedProvider(userId, slug);
  if (!provider) return [] as string[];
  const rows = yield* fromPromise(
    () =>
      db
        .select({ modelId: customProviderModel.modelId })
        .from(customProviderModel)
        .where(eq(customProviderModel.providerId, provider.id)),
    "Failed to load custom provider models"
  );
  return rows.map((row) => row.modelId);
});

const failWith = (message: string) => ({ success: false as const, error: message });

export const createCustomProvider = Effect.fn("customProviders.create")(function* (
  userId: string,
  input: CustomCreateInput
) {
  const baseUrl = normalizeUrl(input.baseUrl);
  if (!baseUrl) return failWith("baseUrl is invalid or targets a private network address.");
  if (PROVIDER_ACCOUNT_KEYS.includes(input.slug as (typeof PROVIDER_ACCOUNT_KEYS)[number])) {
    return failWith(`Slug "${input.slug}" is reserved for a built-in provider.`);
  }
  const existing = yield* ownedProvider(userId, input.slug);
  if (existing) return failWith(`Custom provider "${input.slug}" already exists.`);
  const rows = yield* fromPromise(
    () =>
      db
        .insert(customProvider)
        .values({
          userId,
          slug: input.slug,
          name: input.name,
          baseUrl,
          extraHeaders: input.extraHeaders ?? {},
          enabled: true,
        })
        .returning({ id: customProvider.id, slug: customProvider.slug }),
    "Failed to create custom provider"
  );
  const created = rows[0];
  if (created === undefined) return failWith("Failed to create custom provider.");
  return { success: true as const, data: { id: created.id, slug: created.slug } };
});

export const updateCustomProvider = Effect.fn("customProviders.update")(function* (
  userId: string,
  input: CustomUpdateInput
) {
  const provider = yield* ownedProvider(userId, input.slug);
  if (!provider) return failWith(`Custom provider "${input.slug}" not found.`);
  const baseUrl = input.baseUrl == null ? undefined : normalizeUrl(input.baseUrl);
  if (input.baseUrl != null && !baseUrl) {
    return failWith("baseUrl is invalid or targets a private network address.");
  }
  yield* fromPromise(
    () =>
      db
        .update(customProvider)
        .set({
          ...(input.name != null ? { name: input.name } : {}),
          ...(baseUrl != null ? { baseUrl } : {}),
          ...(input.extraHeaders != null ? { extraHeaders: input.extraHeaders } : {}),
          ...(input.enabled != null ? { enabled: input.enabled } : {}),
        })
        .where(and(eq(customProvider.userId, userId), eq(customProvider.slug, input.slug))),
    "Failed to update custom provider"
  );
  return { success: true as const, data: undefined };
});

export const deleteCustomProvider = Effect.fn("customProviders.delete")(function* (
  userId: string,
  slug: string
) {
  const provider = yield* ownedProvider(userId, slug);
  if (!provider) return failWith(`Custom provider "${slug}" not found.`);
  yield* fromPromise(
    () =>
      db
        .delete(providerAccount)
        .where(and(eq(providerAccount.userId, userId), eq(providerAccount.provider, slug))),
    "Failed to delete custom provider"
  );
  yield* fromPromise(
    () => db.delete(customProvider).where(eq(customProvider.id, provider.id)),
    "Failed to delete custom provider"
  );
  return { success: true as const, data: undefined };
});

export const upsertCustomModels = Effect.fn("customProviders.upsertModels")(function* (
  userId: string,
  slug: string,
  models: CustomModelInput[]
) {
  const provider = yield* ownedProvider(userId, slug);
  if (!provider) return failWith(`Custom provider "${slug}" not found.`);
  const seen = new Set<string>();
  let added = 0;
  for (const input of models) {
    if (seen.has(input.modelId)) continue;
    seen.add(input.modelId);
    const result = yield* fromPromise(
      () =>
        db
          .insert(customProviderModel)
          .values({
            providerId: provider.id,
            modelId: input.modelId,
            upstream: input.upstream ?? input.modelId,
            aliased: input.aliased ?? false,
            authless: input.authless ?? false,
            minTier: input.minTier ?? null,
            allowedTiers: input.allowedTiers ?? null,
            customFlags: input.customFlags ?? {},
          })
          .onConflictDoUpdate({
            target: [customProviderModel.providerId, customProviderModel.modelId],
            set: {
              upstream: input.upstream ?? input.modelId,
              aliased: input.aliased ?? false,
              authless: input.authless ?? false,
              minTier: input.minTier ?? null,
              allowedTiers: input.allowedTiers ?? null,
              customFlags: input.customFlags ?? {},
            },
          })
          .returning({ modelId: customProviderModel.modelId }),
      "Failed to save custom provider models"
    );
    added += result.length;
  }
  return { success: true as const, data: { added } };
});

export const deleteCustomModel = Effect.fn("customProviders.deleteModel")(function* (
  userId: string,
  slug: string,
  modelId: string
) {
  const provider = yield* ownedProvider(userId, slug);
  if (!provider) return failWith(`Custom provider "${slug}" not found.`);
  yield* fromPromise(
    () =>
      db
        .delete(customProviderModel)
        .where(
          and(
            eq(customProviderModel.providerId, provider.id),
            eq(customProviderModel.modelId, modelId)
          )
        ),
    "Failed to delete custom provider model"
  );
  return { success: true as const, data: undefined };
});

const syncFromUpstream = Effect.fn("customProviders.syncFromUpstream")(function* (
  baseUrl: string,
  token?: string,
  extraHeaders?: Record<string, string>
) {
  const response = yield* fetchExternalEffect(`${baseUrl}/models`, {
    method: "GET",
    headers: { ...extraHeaders, Accept: "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    signal: AbortSignal.timeout(VALIDATION_TIMEOUT_MS),
  }).pipe(
    Effect.catch((failure) =>
      failure.message.includes("timed out") || failure.message.includes("timeout")
        ? Effect.succeed(null)
        : Effect.fail(failure)
    )
  );
  if (!response) return failWith("Provider /models request timed out.");
  if (response.headers.get(RELAY_ERROR_HEADER) === "1") {
    return failWith("Unable to reach the provider through the proxy.");
  }
  if (!response.ok) {
    return failWith(`Provider /models endpoint returned HTTP ${response.status}.`);
  }
  const payload = yield* fromPromise(
    async () => ((await response.json().catch(() => null)) as { data?: { id?: string }[] } | { id?: string }[] | null),
    "Provider /models response was not valid JSON."
  );
  if (payload == null) return failWith("Provider /models response was not valid JSON.");
  const ids = (Array.isArray(payload) ? payload : payload.data ?? [])
    .map((item) => item.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  if (ids.length === 0) return failWith("Provider /models returned no model ids.");
  return { success: true as const, data: { ids } };
});

export const syncCustomModels = Effect.fn("customProviders.sync")(function* (
  userId: string,
  slug: string,
  token?: string
) {
  const provider = yield* ownedProvider(userId, slug);
  if (!provider) return failWith(`Custom provider "${slug}" not found.`);
  const effectiveToken = token?.trim() || (yield* storedAccountKey(userId, slug)) || undefined;
  const fetched = yield* syncFromUpstream(provider.baseUrl, effectiveToken, provider.extraHeaders ?? undefined);
  if (!fetched.success) return fetched;
  const upserted = yield* upsertCustomModels(userId, slug, cleanModels(fetched.data.ids));
  if (!upserted.success) return upserted;
  return {
    success: true as const,
    data: { added: upserted.data.added, discovered: fetched.data.ids.length },
  };
});

export const previewCustomModels = Effect.fn("customProviders.preview")(function* (
  input: ModelsPreviewInput
) {
  const baseUrl = normalizeUrl(input.baseUrl);
  if (!baseUrl) return failWith("baseUrl is invalid or targets a private network address.");
  const fetched = yield* syncFromUpstream(baseUrl, input.token, input.extraHeaders);
  if (!fetched.success) return fetched;
  return { success: true as const, data: { models: cleanModels(fetched.data.ids) } };
});

function modelKey(upstream: string): string {
  const slashIndex = upstream.indexOf("/");
  const basename = slashIndex === -1 ? upstream : upstream.slice(slashIndex + 1);
  const slug = basename
    .replace(/[:/]/g, "-")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-{2,}/g, "-")
    .toLowerCase();
  const cleaned = stripParams(slug);
  return cleaned.endsWith("-free") ? cleaned.slice(0, -"-free".length) : cleaned;
}

function cleanModels(upstreamIds: string[]): Array<{ modelId: string; upstream: string }> {
  return [...idMap(upstreamIds, modelKey)].map(([modelId, upstream]) => ({ modelId, upstream }));
}

export const connectCustom = Effect.fn("customProviders.connectAccount")(function* (
  userId: string,
  slug: string,
  apiKey: string,
  name?: string
) {
  const provider = yield* ownedProvider(userId, slug);
  if (!provider) return failWith(`Custom provider "${slug}" not found.`);
  const normalizedKey = apiKey.trim();
  if (!normalizedKey) return failWith("API key is required.");

  const response = yield* fetchExternalEffect(`${provider.baseUrl}/models`, {
    method: "GET",
    headers: { ...provider.extraHeaders, Authorization: `Bearer ${normalizedKey}`, Accept: "application/json" },
    signal: AbortSignal.timeout(VALIDATION_TIMEOUT_MS),
  }).pipe(
    Effect.catch(() =>
      Effect.succeed(new Response(null, { status: 599 }))
    )
  );
  if (response.status === 599) return failWith("Unable to validate the API key. Please check your network and try again.");
  if (response.headers.get(RELAY_ERROR_HEADER) === "1") {
    return failWith("Unable to validate the API key through the proxy.");
  }
  if (!response.ok) {
    const text = yield* fromPromise(
      () => response.text().catch(() => ""),
      "Failed to read provider response"
    );
    if (
      response.status === 401 ||
      response.status === 403 ||
      /unauthorized|invalid api key|invalid key|authentication/i.test(text)
    ) {
      return failWith("API key is invalid.");
    }
    return failWith(`Unable to validate the API key right now (HTTP ${response.status}).`);
  }

  const identifier = `custom-${slug}-${hashString(normalizedKey).slice(0, 16)}`;
  const normalizedName = name?.trim();
  const existing = yield* fromPromise(
    () =>
      db
        .select({ id: providerAccount.id, name: providerAccount.name })
        .from(providerAccount)
        .where(
          and(
            eq(providerAccount.userId, userId),
            eq(providerAccount.provider, slug),
            eq(providerAccount.email, identifier)
          )
        )
        .limit(1),
    "Failed to load custom provider account"
  );
  const existingAccount = existing[0];
  let displayName = normalizedName;
  if (!displayName) {
    displayName = existingAccount?.name;
  }
  if (!displayName) {
    const counts = yield* fromPromise(
      () =>
        db
          .select({ value: count() })
          .from(providerAccount)
          .where(and(eq(providerAccount.userId, userId), eq(providerAccount.provider, slug))),
      "Failed to count custom provider accounts"
    );
    displayName = `${provider.name} ${(counts[0]?.value ?? 0) + 1}`;
  }
  if (existingAccount) {
    yield* fromPromise(
      () =>
        db
          .update(providerAccount)
          .set({
            accessToken: encrypt(normalizedKey),
            refreshToken: encrypt(normalizedKey),
            expiresAt: KEY_ACCOUNT_EXPIRY,
            isActive: true,
            disabledUntil: null,
            ...(normalizedName ? { name: normalizedName } : {}),
          })
          .where(eq(providerAccount.id, existingAccount.id)),
      "Failed to update custom provider account"
    );
    return { success: true as const, data: { isUpdate: true } };
  }
  yield* fromPromise(
    () =>
      db.insert(providerAccount).values({
        userId,
        provider: slug,
        name: displayName,
        accessToken: encrypt(normalizedKey),
        refreshToken: encrypt(normalizedKey),
        expiresAt: KEY_ACCOUNT_EXPIRY,
        email: identifier,
        isActive: true,
      }),
    "Failed to create custom provider account"
  );
  return { success: true as const, data: { isUpdate: false } };
});
