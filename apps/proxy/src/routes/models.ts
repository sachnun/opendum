import { Hono } from "hono";
import { writeOpenAIError } from "../errors.js";
import type { AuthService } from "../auth/service.js";
import type { ModelRegistry } from "@opendum/ai";

export function createModelsRoute(
  authService: AuthService,
  registry: ModelRegistry
) {
  const router = new Hono();

  router.get("/v1/models", async (c) => {
    const authHeader =
      c.req.header("authorization") || c.req.header("x-api-key");
    const allModels = registry.formatModelsForOpenAI();

    let authResult: any = null;

    // Check Playground HMAC auth
    const playgroundUser = c.req.header("x-opendum-playground-user-id");
    const playgroundTs = c.req.header("x-opendum-playground-timestamp");
    const playgroundSig = c.req.header("x-opendum-playground-signature");

    if (playgroundUser && playgroundTs && playgroundSig) {
      authResult = authService.validatePlaygroundAuth(
        playgroundUser,
        playgroundTs,
        playgroundSig,
        c.req.method,
        c.req.path
      );
    }

    if (!authResult && authHeader) {
      authResult = await authService.validateAPIKey(authHeader);
    }

    if (!authHeader && !authResult) {
      return c.json({ object: "list", data: allModels });
    }
    if (!authResult.valid) {
      return writeOpenAIError(c, 401, {
        message: authResult.error || "Unauthorized",
        type: "authentication_error",
      });
    }

    const userId = authResult.userId!;
    const disabledSet = await authService.disabledModelSetForUser(userId);
    const availability =
      await authService.getAccountModelAvailabilityWithSharing(
        userId,
        Boolean(authResult.roamingEnabled)
      );

    const apiKeyModelSet = new Set(
      (authResult.modelAccessList ?? []).map((m: string) => registry.resolveAlias(m))
    );

    const enabled = allModels.filter((item) => {
      const canonical = registry.resolveAlias(item.id);
      if (disabledSet.has(canonical)) return false;

      const usableOwned = authService.isModelUsableByAccounts(
        canonical,
        availability
      );
      const usableShared =
        authResult.roamingEnabled &&
        authService.isModelUsableBySharedAccounts(canonical, availability);

      if (!usableOwned && !usableShared) return false;

      if (authResult.modelAccessMode === "whitelist") {
        if (!apiKeyModelSet.has(canonical)) return false;
      }
      if (authResult.modelAccessMode === "blacklist") {
        if (apiKeyModelSet.has(canonical)) return false;
      }

      return true;
    });

    return c.json({ object: "list", data: enabled });
  });

  return router;
}
