import { defineHandler, type H3, type H3Event } from "h3";
import type { ProxyContext } from "../context.js";
import { jsonResponse } from "./errors.js";

async function handleModels(event: H3Event, context: ProxyContext): Promise<Response> {
  const authHeader = event.req.headers.get("authorization") ?? event.req.headers.get("x-api-key") ?? "";

  let userId = "";
  let apiKeyModelAccessMode = "all";
  let roamingEnabled = false;
  const apiKeyModelSet = new Set<string>();

  if (authHeader) {
    const result = await context.auth.validateAPIKey(authHeader);
    if (!result.valid) {
      return jsonResponse(
        { error: { message: result.error, type: "authentication_error", param: null, code: null } },
        401
      );
    }
    userId = result.userId;
    apiKeyModelAccessMode = result.modelAccessMode;
    roamingEnabled = result.roamingEnabled;
    for (const model of result.modelAccessList) {
      apiKeyModelSet.add(context.models.resolveAlias(model));
    }
  }

  const allModels = context.models.formatModelsForOpenAI();
  if (!userId) {
    return jsonResponse({ object: "list", data: allModels });
  }

  const disabledSet = await context.auth.disabledModelSetForUser(userId);
  const availability = await context.auth.getAccountModelAvailabilityWithSharing(userId, roamingEnabled);

  const enabled: Array<Record<string, unknown>> = [];
  for (const item of allModels) {
    const id = typeof item.id === "string" ? item.id : "";
    const canonical = context.models.resolveAlias(id);
    if (disabledSet.has(canonical)) continue;
    const usable =
      context.auth.isModelUsableByAccounts(canonical, availability) ||
      (roamingEnabled && context.auth.isModelUsableBySharedAccounts(canonical, availability));
    if (!usable) continue;
    const providers = Array.isArray(item.providers) ? (item.providers as string[]) : [];
    if (apiKeyModelAccessMode === "whitelist") {
      if (apiKeyModelSet.has(canonical)) enabled.push(item);
      for (const provider of providers) {
        if (apiKeyModelSet.has(`${provider}/${canonical}`)) enabled.push({ ...item, id: `${provider}/${canonical}` });
      }
      continue;
    }
    if (apiKeyModelAccessMode === "blacklist") {
      if (apiKeyModelSet.has(canonical)) continue;
      const remaining = providers.filter((provider) => !apiKeyModelSet.has(`${provider}/${canonical}`));
      enabled.push(remaining.length === providers.length ? item : { ...item, providers: remaining });
      continue;
    }
    enabled.push(item);
  }

  const customModels = await context.auth.listUserCustomModels(userId);
  for (const item of customModels) {
    const id = typeof item.id === "string" ? item.id : "";
    const canonical = context.models.resolveAlias(id);
    if (disabledSet.has(id) || disabledSet.has(canonical)) continue;
    let slug = id;
    const index = slug.indexOf("/");
    if (index > 0) slug = slug.slice(0, index);
    if (!availability.accountCountByProvider.has(slug)) continue;
    if (apiKeyModelAccessMode === "whitelist" && !apiKeyModelSet.has(id)) continue;
    if (apiKeyModelAccessMode === "blacklist" && apiKeyModelSet.has(id)) continue;
    enabled.push(item);
  }

  return jsonResponse({ object: "list", data: enabled });
}

export function registerModelsRoute(app: H3, context: ProxyContext): void {
  app.get(
    "/v1/models",
    defineHandler((event) => handleModels(event, context))
  );
}
