import { Effect } from "effect";
import type { H3Event } from "h3";
import type { ProxyContext } from "@opendum/api/core/context";
import { listVisibleModels, type ModelIdentity } from "@opendum/api/handlers/model-listing";
import { internalResponse, jsonResponse } from "@opendum/api/handlers/errors";

export async function handleModels(event: H3Event, context: ProxyContext): Promise<Response> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const authHeader = event.req.headers.get("authorization") ?? event.req.headers.get("x-api-key") ?? "";

      const identity: ModelIdentity = { userId: "", accessMode: "all", accessList: [], roamingEnabled: false };

      if (authHeader) {
        const result = yield* context.auth.validateKey(authHeader);
        if (!result.valid) {
          return jsonResponse(
            { error: { message: result.error, type: "authentication_error", param: null, code: null } },
            401
          );
        }
        identity.userId = result.userId;
        identity.accessMode = result.modelAccessMode;
        identity.accessList = result.modelAccessList;
        identity.roamingEnabled = result.roamingEnabled;
      }

      const data = yield* listVisibleModels(context, identity);
      return jsonResponse({ object: "list", data });
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
