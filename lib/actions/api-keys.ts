"use server";

import { Effect } from "effect";
import { DatabaseService, requireUserId } from "@/lib/effect/services";
import { DatabaseError, NotFoundError, ValidationError } from "@/lib/effect/errors";
import { runServerAction, MainLayer, type ActionResult } from "@/lib/effect/runtime";
import { proxyApiKey } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { generateApiKey, hashString, getKeyPreview, encrypt, decrypt } from "@/lib/encryption";
import { invalidateApiKeyValidationCache } from "@/lib/proxy/auth";
import { isModelSupported, resolveModelAlias } from "@/lib/proxy/models";
import { revalidatePath } from "next/cache";

export type ApiKeyModelAccessMode = "all" | "whitelist" | "blacklist";

const API_KEY_MODEL_ACCESS_MODES: ApiKeyModelAccessMode[] = ["all", "whitelist", "blacklist"];

function isApiKeyModelAccessMode(value: string): value is ApiKeyModelAccessMode {
  return API_KEY_MODEL_ACCESS_MODES.includes(value as ApiKeyModelAccessMode);
}

function normalizeModelList(models: string[]): string[] {
  const normalized = models
    .map((model) => resolveModelAlias(model.trim()))
    .filter((model) => model.length > 0);

  return Array.from(new Set(normalized)).sort((a, b) => a.localeCompare(b));
}

/**
 * Create a new API key
 */
export async function createApiKey(
  name?: string,
  expiresAt?: Date | null
): Promise<ActionResult<{ id: string; key: string; keyPreview: string; name: string | null; expiresAt: Date | null }>> {
  return runServerAction(
    Effect.gen(function* () {
      const userId = yield* requireUserId;
      const db = yield* DatabaseService;

      const key = generateApiKey();
      const keyHash = hashString(key);
      const keyPreview = getKeyPreview(key);
      const encryptedKey = encrypt(key);
      const trimmedName = name?.trim() || null;

      const [apiKey] = yield* Effect.tryPromise({
        try: () =>
          db.insert(proxyApiKey).values({
            userId,
            keyHash,
            keyPreview,
            encryptedKey,
            name: trimmedName,
            expiresAt: expiresAt ?? null,
          }).returning(),
        catch: (cause) => new DatabaseError({ cause }),
      });

      yield* Effect.sync(() => revalidatePath("/dashboard/api-keys"));

      return {
        id: apiKey.id,
        key,
        keyPreview,
        name: apiKey.name,
        expiresAt: apiKey.expiresAt,
      };
    }),
    MainLayer
  );
}

/**
 * Toggle API key active status (enable/disable)
 */
export async function toggleApiKey(id: string): Promise<ActionResult> {
  return runServerAction(
    Effect.gen(function* () {
      const userId = yield* requireUserId;
      const db = yield* DatabaseService;

      const [apiKey] = yield* Effect.tryPromise({
        try: () =>
          db.select().from(proxyApiKey)
            .where(and(eq(proxyApiKey.id, id), eq(proxyApiKey.userId, userId)))
            .limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });

      if (!apiKey) {
        return yield* new NotFoundError({ message: "API key not found" });
      }

      yield* Effect.tryPromise({
        try: () =>
          db.update(proxyApiKey).set({ isActive: !apiKey.isActive }).where(eq(proxyApiKey.id, id)),
        catch: (cause) => new DatabaseError({ cause }),
      });

      yield* Effect.tryPromise({
        try: () => invalidateApiKeyValidationCache(apiKey.keyHash, apiKey.id),
        catch: (cause) => new DatabaseError({ cause }),
      });

      yield* Effect.sync(() => revalidatePath("/dashboard/api-keys"));
    }),
    MainLayer
  );
}

/**
 * Delete an API key permanently
 */
export async function deleteApiKey(id: string): Promise<ActionResult> {
  return runServerAction(
    Effect.gen(function* () {
      const userId = yield* requireUserId;
      const db = yield* DatabaseService;

      const [apiKey] = yield* Effect.tryPromise({
        try: () =>
          db.select().from(proxyApiKey)
            .where(and(eq(proxyApiKey.id, id), eq(proxyApiKey.userId, userId)))
            .limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });

      if (!apiKey) {
        return yield* new NotFoundError({ message: "API key not found" });
      }

      yield* Effect.tryPromise({
        try: () => db.delete(proxyApiKey).where(eq(proxyApiKey.id, id)),
        catch: (cause) => new DatabaseError({ cause }),
      });

      yield* Effect.tryPromise({
        try: () => invalidateApiKeyValidationCache(apiKey.keyHash, apiKey.id),
        catch: (cause) => new DatabaseError({ cause }),
      });

      yield* Effect.sync(() => revalidatePath("/dashboard/api-keys"));
    }),
    MainLayer
  );
}

/**
 * Update API key name
 */
export async function updateApiKeyName(id: string, name: string): Promise<ActionResult<{ name: string | null }>> {
  return runServerAction(
    Effect.gen(function* () {
      const userId = yield* requireUserId;
      const db = yield* DatabaseService;

      const [apiKey] = yield* Effect.tryPromise({
        try: () =>
          db.select().from(proxyApiKey)
            .where(and(eq(proxyApiKey.id, id), eq(proxyApiKey.userId, userId)))
            .limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });

      if (!apiKey) {
        return yield* new NotFoundError({ message: "API key not found" });
      }

      const trimmedName = name?.trim() || null;

      const [updatedKey] = yield* Effect.tryPromise({
        try: () =>
          db.update(proxyApiKey).set({ name: trimmedName })
            .where(eq(proxyApiKey.id, id))
            .returning({ name: proxyApiKey.name }),
        catch: (cause) => new DatabaseError({ cause }),
      });

      yield* Effect.sync(() => revalidatePath("/dashboard/api-keys"));

      return { name: updatedKey.name };
    }),
    MainLayer
  );
}

/**
 * Update per-key model access mode and model list
 */
export async function updateApiKeyModelAccess(
  id: string,
  mode: ApiKeyModelAccessMode,
  models: string[]
): Promise<ActionResult<{ mode: ApiKeyModelAccessMode; models: string[] }>> {
  return runServerAction(
    Effect.gen(function* () {
      const userId = yield* requireUserId;
      const db = yield* DatabaseService;

      if (!isApiKeyModelAccessMode(mode)) {
        return yield* new ValidationError({ message: "Invalid model access mode" });
      }

      const [apiKey] = yield* Effect.tryPromise({
        try: () =>
          db.select({ id: proxyApiKey.id, keyHash: proxyApiKey.keyHash }).from(proxyApiKey)
            .where(and(eq(proxyApiKey.id, id), eq(proxyApiKey.userId, userId)))
            .limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });

      if (!apiKey) {
        return yield* new NotFoundError({ message: "API key not found" });
      }

      const normalizedModels = mode === "all" ? [] : normalizeModelList(models);

      if (mode !== "all" && normalizedModels.length === 0) {
        return yield* new ValidationError({ message: "Select at least one model" });
      }

      const invalidModels = normalizedModels.filter((model) => !isModelSupported(model));
      if (invalidModels.length > 0) {
        return yield* new ValidationError({ message: `Unknown model: ${invalidModels[0]}` });
      }

      const [updated] = yield* Effect.tryPromise({
        try: () =>
          db.update(proxyApiKey).set({
            modelAccessMode: mode,
            modelAccessList: normalizedModels,
          }).where(eq(proxyApiKey.id, id)).returning({
            modelAccessMode: proxyApiKey.modelAccessMode,
            modelAccessList: proxyApiKey.modelAccessList,
          }),
        catch: (cause) => new DatabaseError({ cause }),
      });

      yield* Effect.tryPromise({
        try: () => invalidateApiKeyValidationCache(apiKey.keyHash, apiKey.id),
        catch: (cause) => new DatabaseError({ cause }),
      });

      yield* Effect.sync(() => {
        revalidatePath("/dashboard/api-keys");
        revalidatePath("/dashboard");
      });

      return {
        mode: isApiKeyModelAccessMode(updated.modelAccessMode)
          ? updated.modelAccessMode
          : "all",
        models: updated.modelAccessList,
      };
    }),
    MainLayer
  );
}

/**
 * Reveal the full API key
 */
export async function revealApiKey(id: string): Promise<ActionResult<{ key: string }>> {
  return runServerAction(
    Effect.gen(function* () {
      const userId = yield* requireUserId;
      const db = yield* DatabaseService;

      const [apiKey] = yield* Effect.tryPromise({
        try: () =>
          db.select({
            id: proxyApiKey.id,
            encryptedKey: proxyApiKey.encryptedKey,
            isActive: proxyApiKey.isActive,
          }).from(proxyApiKey)
            .where(and(eq(proxyApiKey.id, id), eq(proxyApiKey.userId, userId)))
            .limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });

      if (!apiKey) {
        return yield* new NotFoundError({ message: "API key not found" });
      }

      if (!apiKey.encryptedKey) {
        return yield* new ValidationError({
          message: "This API key was created before the reveal feature. Please generate a new key.",
        });
      }

      const key = decrypt(apiKey.encryptedKey);

      return { key };
    }),
    MainLayer
  );
}
