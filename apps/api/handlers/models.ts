import { Effect } from "effect";
import type { H3Event } from "h3";
import type { ProxyContext } from "@opendum/api/core/context";
import { internalResponse, jsonResponse } from "@opendum/api/handlers/errors";

export async function handleModels(event: H3Event, context: ProxyContext): Promise<Response> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const authHeader = event.req.headers.get("authorization") ?? event.req.headers.get("x-api-key") ?? "";

      let userId = "";
      let keyAccessMode = "all";
      let roamingEnabled = false;
      const keyModelSet = new Set<string>();

      if (authHeader) {
        const result = yield* context.auth.validateKey(authHeader);
        if (!result.valid) {
          return jsonResponse(
            { error: { message: result.error, type: "authentication_error", param: null, code: null } },
            401
          );
        }
        userId = result.userId;
        keyAccessMode = result.modelAccessMode;
        roamingEnabled = result.roamingEnabled;
        for (const model of result.modelAccessList) {
          keyModelSet.add(context.models.resolveAlias(model));
        }
      }

      const allModels = context.models.openAiModels();
      if (!userId) {
        return jsonResponse({ object: "list", data: allModels });
      }

      const disabledSet = yield* context.auth.disabledModels(userId);
      const availability = yield* context.auth.availability(userId, roamingEnabled);

      const enabled: Array<Record<string, unknown>> = [];
      for (const item of allModels) {
        const id = typeof item.id === "string" ? item.id : "";
        const canonical = context.models.resolveAlias(id);
        if (disabledSet.has(canonical)) continue;
        const usable =
          context.auth.usable(canonical, availability) ||
          (roamingEnabled && context.auth.usableShared(canonical, availability));
        if (!usable) continue;
        const providers = Array.isArray(item.providers) ? (item.providers as string[]) : [];
        if (keyAccessMode === "whitelist") {
          if (keyModelSet.has(canonical)) enabled.push(item);
          for (const provider of providers) {
            if (keyModelSet.has(`${provider}/${canonical}`)) {
              enabled.push({ ...item, id: `${provider}/${canonical}` });
            }
          }
          continue;
        }
        if (keyAccessMode === "blacklist") {
          if (keyModelSet.has(canonical)) continue;
          const remaining = providers.filter((provider) => !keyModelSet.has(`${provider}/${canonical}`));
          enabled.push(remaining.length === providers.length ? item : { ...item, providers: remaining });
          continue;
        }
        enabled.push(item);
      }

      const customModels = yield* context.auth.list(userId);
      for (const item of customModels) {
        const id = typeof item.id === "string" ? item.id : "";
        const canonical = context.models.resolveAlias(id);
        if (disabledSet.has(id) || disabledSet.has(canonical)) continue;
        let slug = id;
        const index = slug.indexOf("/");
        if (index > 0) slug = slug.slice(0, index);
        if (!availability.accountCountByProvider.has(slug)) continue;
        if (keyAccessMode === "whitelist" && !keyModelSet.has(id)) continue;
        if (keyAccessMode === "blacklist" && keyModelSet.has(id)) continue;
        enabled.push(item);
      }

      return jsonResponse({ object: "list", data: enabled });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          void Effect.runFork(
            Effect.logError("model listing failed").pipe(Effect.annotateLogs({ cause: String(cause) }))
          );
          return internalResponse("openai", "Failed to list models");
        })
      ),
      Effect.withSpan("handleModels")
    )
  );
}
