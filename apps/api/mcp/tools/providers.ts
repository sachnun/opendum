import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { DATA_OUTPUT, DESTRUCTIVE, READ_ONLY, WRITE, call, jsonResult, needsUser, type ToolEnv } from "@opendum/api/mcp/tools/shared";

const SLUG = z.string().trim().toLowerCase().min(1).describe("Custom provider slug");

const CUSTOM_MODEL = z.object({
  modelId: z.string().trim().min(1).max(120),
  upstream: z.string().trim().max(200).optional(),
  aliased: z.boolean().optional(),
  authless: z.boolean().optional(),
  minTier: z.string().trim().max(60).optional(),
  allowedTiers: z.array(z.string().trim().min(1)).optional(),
  customFlags: z
    .object({
      responses_api: z.boolean().optional(),
      top_p_deprecated: z.boolean().optional(),
      convert_external_images: z.boolean().optional(),
    })
    .optional(),
});

export function registerProviderTools(server: McpServer, env: ToolEnv): void {
  server.registerTool(
    "providers_list",
    {
      title: "List custom providers",
      description:
        "List the user's custom OpenAI-compatible providers with base URL, enabled state, and model counts.\n\nUse when: manage third-party endpoints behind the gateway.\nRisk: read.",
      outputSchema: DATA_OUTPUT,
      annotations: READ_ONLY,
    },
    async () => {
      const guard = needsUser(env);
      if ("error" in guard) return guard.error;
      const result = await call("list custom providers", env.context.web.customProviders.listCustomProviders(guard.userId));
      return "value" in result ? jsonResult(result.value) : result.error;
    }
  );

  server.registerTool(
    "providers_create",
    {
      title: "Create custom provider",
      description:
        "Create a custom OpenAI-compatible provider with a base URL and optional default headers.\n\nUse when: expose an OpenAI-compatible endpoint through opendum.\nRisk: write.",
      inputSchema: z.object({
        slug: SLUG,
        name: z.string().trim().min(1).max(120),
        baseUrl: z.string().trim().min(1).max(500),
        extraHeaders: z.record(z.string(), z.string()).optional(),
      }),
      outputSchema: DATA_OUTPUT,
      annotations: WRITE,
    },
    async (args) => {
      const guard = needsUser(env);
      if ("error" in guard) return guard.error;
      const result = await call("create custom provider", env.context.web.customProviders.createCustomProvider(guard.userId, args));
      return "value" in result ? jsonResult(result.value) : result.error;
    }
  );

  server.registerTool(
    "providers_update",
    {
      title: "Update custom provider",
      description:
        "Update a custom provider's name, base URL, headers, or enabled state.\n\nUse when: repoint a provider or pause it without deleting.\nRisk: write.",
      inputSchema: z.object({
        slug: SLUG,
        name: z.string().trim().min(1).max(120).optional(),
        baseUrl: z.string().trim().min(1).max(500).optional(),
        extraHeaders: z.record(z.string(), z.string()).optional(),
        enabled: z.boolean().optional(),
      }),
      outputSchema: DATA_OUTPUT,
      annotations: WRITE,
    },
    async (args) => {
      const guard = needsUser(env);
      if ("error" in guard) return guard.error;
      const result = await call("update custom provider", env.context.web.customProviders.updateCustomProvider(guard.userId, args));
      return "value" in result ? jsonResult(result.value) : result.error;
    }
  );

  server.registerTool(
    "providers_delete",
    {
      title: "Delete custom provider",
      description:
        "Delete a custom provider and its stored model config.\n\nUse when: remove a third-party endpoint entirely.\nRisk: destructive.",
      inputSchema: z.object({ slug: SLUG }),
      outputSchema: DATA_OUTPUT,
      annotations: DESTRUCTIVE,
    },
    async (args) => {
      const guard = needsUser(env);
      if ("error" in guard) return guard.error;
      const result = await call("delete custom provider", env.context.web.customProviders.deleteCustomProvider(guard.userId, args.slug));
      return "value" in result ? jsonResult(result.value) : result.error;
    }
  );

  server.registerTool(
    "providers_connect",
    {
      title: "Connect custom provider account",
      description:
        "Connect (or update) an account credential for a custom provider. The token is stored encrypted.\n\nUse when: attach a key to a custom endpoint so its models can serve.\nRisk: write.",
      inputSchema: z.object({
        slug: SLUG,
        token: z.string().trim().min(1),
        name: z.string().trim().max(120).optional(),
      }),
      outputSchema: DATA_OUTPUT,
      annotations: WRITE,
    },
    async (args) => {
      const guard = needsUser(env);
      if ("error" in guard) return guard.error;
      const result = await call("connect custom provider", env.context.web.customProviders.connectCustom(guard.userId, args.slug, args.token, args.name));
      return "value" in result ? jsonResult(result.value) : result.error;
    }
  );

  server.registerTool(
    "providers_models_sync",
    {
      title: "Sync custom provider models",
      description:
        "Fetch the model list from a custom provider's endpoint and upsert it into opendum.\n\nUse when: refresh a custom provider's models after the upstream changes.\nRisk: write.",
      inputSchema: z.object({ slug: SLUG, token: z.string().trim().optional() }),
      outputSchema: DATA_OUTPUT,
      annotations: WRITE,
    },
    async (args) => {
      const guard = needsUser(env);
      if ("error" in guard) return guard.error;
      const result = await call("sync custom models", env.context.web.customProviders.syncCustomModels(guard.userId, args.slug, args.token));
      return "value" in result ? jsonResult(result.value) : result.error;
    }
  );

  server.registerTool(
    "providers_models_preview",
    {
      title: "Preview provider models",
      description:
        "Preview the models an OpenAI-compatible base URL exposes, without saving anything.\n\nUse when: validate a base URL and token before creating the provider.\nRisk: read.",
      inputSchema: z.object({
        baseUrl: z.string().trim().min(1).max(500),
        extraHeaders: z.record(z.string(), z.string()).optional(),
        token: z.string().trim().optional(),
      }),
      outputSchema: DATA_OUTPUT,
      annotations: READ_ONLY,
    },
    async (args) => {
      const guard = needsUser(env);
      if ("error" in guard) return guard.error;
      const result = await call("preview custom models", env.context.web.customProviders.previewCustomModels(args));
      return "value" in result ? jsonResult(result.value) : result.error;
    }
  );

  server.registerTool(
    "providers_models_upsert",
    {
      title: "Upsert provider models",
      description:
        "Upsert model configs (upstream mapping, tiers, authless, flags) for a custom provider.\n\nUse when: hand-tune which upstream model each opendum id resolves to.\nRisk: write.",
      inputSchema: z.object({ slug: SLUG, models: z.array(CUSTOM_MODEL).min(1).max(500) }),
      outputSchema: DATA_OUTPUT,
      annotations: WRITE,
    },
    async (args) => {
      const guard = needsUser(env);
      if ("error" in guard) return guard.error;
      const result = await call("upsert custom models", env.context.web.customProviders.upsertCustomModels(guard.userId, args.slug, args.models));
      return "value" in result ? jsonResult(result.value) : result.error;
    }
  );

  server.registerTool(
    "providers_model_delete",
    {
      title: "Delete provider model",
      description:
        "Delete one model config from a custom provider.\n\nUse when: hide a single upstream model from the gateway.\nRisk: destructive.",
      inputSchema: z.object({ slug: SLUG, modelId: z.string().trim().min(1).max(120) }),
      outputSchema: DATA_OUTPUT,
      annotations: DESTRUCTIVE,
    },
    async (args) => {
      const guard = needsUser(env);
      if ("error" in guard) return guard.error;
      const result = await call("delete custom model", env.context.web.customProviders.deleteCustomModel(guard.userId, args.slug, args.modelId));
      return "value" in result ? jsonResult(result.value) : result.error;
    }
  );
}
