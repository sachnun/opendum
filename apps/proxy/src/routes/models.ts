import type { FastifyRequest, FastifyReply, RouteHandlerMethod } from "fastify";
import {
  validateApiKey,
  getDisabledModelSetForUser,
  formatModelsForOpenAI,
  resolveModelAlias,
} from "@opendum/shared";

export const modelsRoute: RouteHandlerMethod = async (
  request: FastifyRequest,
  reply: FastifyReply
) => {
  const authHeader =
    (request.headers.authorization as string | undefined) ??
    (request.headers["x-api-key"] as string | undefined) ??
    null;

  let userId: string | null = null;
  let apiKeyModelAccessMode: "all" | "whitelist" | "blacklist" = "all";
  let apiKeyModelSet = new Set<string>();

  if (authHeader) {
    const authResult = await validateApiKey(authHeader);

    if (!authResult.valid) {
      return reply.code(401).send({
        error: { message: authResult.error, type: "authentication_error" },
      });
    }

    userId = authResult.userId ?? null;
    apiKeyModelAccessMode = authResult.modelAccessMode ?? "all";
    apiKeyModelSet = new Set(
      (authResult.modelAccessList ?? []).map((model) => resolveModelAlias(model))
    );
  }

  const allModels = formatModelsForOpenAI();

  if (!userId) {
    return reply.send({
      object: "list",
      data: allModels,
    });
  }

  const disabledModelSet = await getDisabledModelSetForUser(userId);
  const enabledModels = allModels.filter((model) => {
    const canonicalModel = resolveModelAlias(model.id);

    if (disabledModelSet.has(canonicalModel)) {
      return false;
    }

    if (apiKeyModelAccessMode === "whitelist") {
      return apiKeyModelSet.has(canonicalModel);
    }

    if (apiKeyModelAccessMode === "blacklist") {
      return !apiKeyModelSet.has(canonicalModel);
    }

    return true;
  });

  return reply.send({
    object: "list",
    data: enabledModels,
  });
};
