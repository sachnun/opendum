import { Effect } from "effect";
import type { AuthService } from "@opendum/auth";
import type { DatabaseFailure } from "@opendum/database";
import type { Registry } from "@opendum/models/runtime";

export type ModelIdentity = {
  userId: string;
  accessMode: string;
  accessList: string[];
  roamingEnabled: boolean;
};

export type ModelListingContext = {
  models: Pick<Registry, "openAiModels" | "resolveAlias">;
  auth: Pick<AuthService, "disabledModels" | "availability" | "usable" | "usableShared" | "list">;
};

export function listVisibleModels(
  context: ModelListingContext,
  identity: ModelIdentity
): Effect.Effect<Array<Record<string, unknown>>, DatabaseFailure> {
  return Effect.gen(function* () {
    const allModels = context.models.openAiModels();
    if (!identity.userId) return allModels;

    const keyModelSet = new Set<string>();
    for (const model of identity.accessList) keyModelSet.add(context.models.resolveAlias(model));

    const disabledSet = yield* context.auth.disabledModels(identity.userId);
    const availability = yield* context.auth.availability(identity.userId, identity.roamingEnabled);

    const enabled: Array<Record<string, unknown>> = [];
    for (const item of allModels) {
      const id = typeof item.id === "string" ? item.id : "";
      const canonical = context.models.resolveAlias(id);
      if (disabledSet.has(canonical)) continue;
      const usable =
        context.auth.usable(canonical, availability) ||
        (identity.roamingEnabled && context.auth.usableShared(canonical, availability));
      if (!usable) continue;
      const providers = Array.isArray(item.providers) ? (item.providers as string[]) : [];
      if (identity.accessMode === "whitelist") {
        if (keyModelSet.has(canonical)) enabled.push(item);
        for (const provider of providers) {
          if (keyModelSet.has(`${provider}/${canonical}`)) {
            enabled.push({ ...item, id: `${provider}/${canonical}` });
          }
        }
        continue;
      }
      if (identity.accessMode === "blacklist") {
        if (keyModelSet.has(canonical)) continue;
        const remaining = providers.filter((provider) => !keyModelSet.has(`${provider}/${canonical}`));
        enabled.push(remaining.length === providers.length ? item : { ...item, providers: remaining });
        continue;
      }
      enabled.push(item);
    }

    const customModels = yield* context.auth.list(identity.userId);
    for (const item of customModels) {
      const id = typeof item.id === "string" ? item.id : "";
      const canonical = context.models.resolveAlias(id);
      if (disabledSet.has(id) || disabledSet.has(canonical)) continue;
      let slug = id;
      const index = slug.indexOf("/");
      if (index > 0) slug = slug.slice(0, index);
      if (!availability.accountCountByProvider.has(slug)) continue;
      if (identity.accessMode === "whitelist" && !keyModelSet.has(id)) continue;
      if (identity.accessMode === "blacklist" && keyModelSet.has(id)) continue;
      enabled.push(item);
    }

    return enabled;
  });
}
