"use server";

import { Effect } from "effect";
import { DatabaseService, requireUserId } from "@/lib/effect/services";
import { DatabaseError, ValidationError } from "@/lib/effect/errors";
import { runServerAction, MainLayer, type ActionResult } from "@/lib/effect/runtime";
import { disabledModel } from "@/lib/db/schema";
import { eq, and, inArray } from "drizzle-orm";
import { invalidateDisabledModelsCache } from "@/lib/proxy/auth";
import {
  getModelLookupKeys,
  isModelSupported,
  resolveModelAlias,
} from "@/lib/proxy/models";
import { revalidatePath } from "next/cache";

export type { ActionResult };

/**
 * Enable or disable a model for the current user.
 */
export async function setModelEnabled(
  modelId: string,
  enabled: boolean
): Promise<ActionResult<{ model: string; enabled: boolean }>> {
  return runServerAction(
    Effect.gen(function* () {
      const userId = yield* requireUserId;
      const db = yield* DatabaseService;

      const normalizedModel = resolveModelAlias(modelId.trim());

      if (!normalizedModel || !isModelSupported(normalizedModel)) {
        return yield* new ValidationError({ message: "Model not found" });
      }

      if (enabled) {
        const modelLookupKeys = getModelLookupKeys(normalizedModel);
        yield* Effect.tryPromise({
          try: () =>
            db
              .delete(disabledModel)
              .where(
                and(
                  eq(disabledModel.userId, userId),
                  inArray(disabledModel.model, modelLookupKeys)
                )
              ),
          catch: (cause) => new DatabaseError({ cause }),
        });
      } else {
        yield* Effect.tryPromise({
          try: () =>
            db
              .insert(disabledModel)
              .values({
                userId,
                model: normalizedModel,
              })
              .onConflictDoNothing({
                target: [disabledModel.userId, disabledModel.model],
              }),
          catch: (cause) => new DatabaseError({ cause }),
        });
      }

      yield* Effect.tryPromise({
        try: () => invalidateDisabledModelsCache(userId),
        catch: (cause) => new DatabaseError({ cause }),
      });

      yield* Effect.sync(() => {
        revalidatePath("/dashboard", "layout");
        revalidatePath("/dashboard/models");
        revalidatePath("/dashboard/playground");
      });

      return { model: normalizedModel, enabled };
    }),
    MainLayer
  );
}
