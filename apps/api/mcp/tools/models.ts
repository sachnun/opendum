import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { DATA_OUTPUT, READ_ONLY, WRITE, call, jsonResult, needsUser, type ToolEnv } from "@opendum/api/mcp/tools/shared";

export function registerModelTools(server: McpServer, env: ToolEnv): void {
  server.registerTool(
    "models_catalog_read",
    {
      title: "Model catalog",
      description:
        "Read the full model catalog ids known to opendum, regardless of key access.\n\nUse when: browse every model id; find ids that models_list hides behind key policy.\nRisk: read.",
      outputSchema: DATA_OUTPUT,
      annotations: READ_ONLY,
    },
    async () => jsonResult(env.context.web.models.knownModels())
  );

  server.registerTool(
    "models_search",
    {
      title: "Search models",
      description:
        "Search the models available to the connected user, with provider and enabled state per model.\n\nUse when: dashboard-style model discovery; check which models are enabled for the user.\nRisk: read.",
      outputSchema: DATA_OUTPUT,
      annotations: READ_ONLY,
    },
    async () => {
      const guard = needsUser(env);
      if ("error" in guard) return guard.error;
      const result = await call("search models", env.context.web.models.searchModels(guard.userId));
      return "value" in result ? jsonResult(result.value) : result.error;
    }
  );

  server.registerTool(
    "models_families_list",
    {
      title: "Model families",
      description:
        "List model families with their model counts from the opendum catalog.\n\nUse when: group models by family for exploration.\nRisk: read.",
      outputSchema: DATA_OUTPUT,
      annotations: READ_ONLY,
    },
    async () => jsonResult(env.context.web.models.familyCounts())
  );

  server.registerTool(
    "models_stats_read",
    {
      title: "Model stats",
      description:
        "Read usage statistics for a batch of models: request and token totals, success rate, daily requests, latency.\n\nUse when: rank models by real usage; evaluate a model before selecting it.\nRisk: read.",
      inputSchema: z.object({ models: z.array(z.string()).max(50).describe("Model ids from models_list") }),
      outputSchema: DATA_OUTPUT,
      annotations: READ_ONLY,
    },
    async (args) => {
      const guard = needsUser(env);
      if ("error" in guard) return guard.error;
      const result = await call("read model stats", env.context.web.models.getModelStats(guard.userId, args));
      return "value" in result ? jsonResult(result.value) : result.error;
    }
  );

  server.registerTool(
    "models_detailed_list",
    {
      title: "Detailed model list",
      description:
        "List the dashboard model catalog with enabled state, providers, per-model info, and optionally usage stats.\n\nUse when: full catalog audit; verify which models are enabled but unavailable.\nRisk: read.",
      inputSchema: z.object({ includeStats: z.boolean().optional().describe("Attach usage stats per model") }),
      outputSchema: DATA_OUTPUT,
      annotations: READ_ONLY,
    },
    async (args) => {
      const guard = needsUser(env);
      if ("error" in guard) return guard.error;
      const result = await call("list detailed models", env.context.web.models.listModels(guard.userId, args));
      return "value" in result ? jsonResult(result.value) : result.error;
    }
  );

  server.registerTool(
    "models_enabled_update",
    {
      title: "Enable or disable model",
      description:
        "Enable or disable one model for the connected user. Disabled models vanish from models_list and chat_create.\n\nUse when: restrict the user's model set; re-enable a model.\nRisk: write.",
      inputSchema: z.object({
        modelId: z.string().min(1).describe("Model id from models_list"),
        enabled: z.boolean(),
      }),
      outputSchema: DATA_OUTPUT,
      annotations: WRITE,
    },
    async (args) => {
      const guard = needsUser(env);
      if ("error" in guard) return guard.error;
      const result = await call("update model status", env.context.web.models.enableModel(guard.userId, args));
      return "value" in result ? jsonResult(result.value) : result.error;
    }
  );
}
