import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { DATA_OUTPUT, READ_ONLY, call, jsonResult, needsUser, type ToolEnv } from "@opendum/api/mcp/tools/shared";

const PERIOD = z.enum(["5m", "15m", "30m", "1h", "6h", "24h", "7d", "30d", "90d"]);
const FILTER = z.union([PERIOD, z.object({ from: z.string().min(1), to: z.string().min(1) })]);

export function registerAnalyticsTools(server: McpServer, env: ToolEnv): void {
  server.registerTool(
    "analytics_overview_read",
    {
      title: "Analytics overview",
      description:
        "Read a 24h usage overview: requests, tokens, errors, success rate, average duration.\n\nUse when: quick health-of-usage snapshot.\nRisk: read.",
      outputSchema: DATA_OUTPUT,
      annotations: READ_ONLY,
    },
    async () => {
      const guard = needsUser(env);
      if ("error" in guard) return guard.error;
      const result = await call("read analytics overview", env.context.web.analytics.getAnalyticsOverview(guard.userId));
      return "value" in result ? jsonResult(result.value) : result.error;
    }
  );

  server.registerTool(
    "analytics_data_read",
    {
      title: "Analytics data",
      description:
        "Read analytics aggregates for a period (or custom from/to range), with totals and optionally time series, optionally scoped to one API key.\n\nUse when: analyze request and token trends over time.\nRisk: read.",
      inputSchema: z.object({
        filter: FILTER.optional().describe("Period like 24h, 7d, 30d, or a {from, to} range"),
        apiKeyId: z.string().trim().min(1).optional(),
        includeSeries: z.boolean().optional(),
      }),
      outputSchema: DATA_OUTPUT,
      annotations: READ_ONLY,
    },
    async (args) => {
      const guard = needsUser(env);
      if ("error" in guard) return guard.error;
      const result = await call("read analytics data", env.context.web.analytics.getAnalyticsData(guard.userId, args));
      return "value" in result ? jsonResult(result.value) : result.error;
    }
  );

  server.registerTool(
    "analytics_series_read",
    {
      title: "Analytics series",
      description:
        "Read time series of requests, token usage, success rate, and duration for a period, optionally scoped to one API key.\n\nUse when: chart usage over time.\nRisk: read.",
      inputSchema: z.object({
        filter: FILTER.optional(),
        apiKeyId: z.string().trim().min(1).optional(),
      }),
      outputSchema: DATA_OUTPUT,
      annotations: READ_ONLY,
    },
    async (args) => {
      const guard = needsUser(env);
      if ("error" in guard) return guard.error;
      const result = await call("read analytics series", env.context.web.analytics.getAnalyticsSeries(guard.userId, args));
      return "value" in result ? jsonResult(result.value) : result.error;
    }
  );

  server.registerTool(
    "analytics_usage_list",
    {
      title: "Usage rows",
      description:
        "List raw usage log rows for a period (provider, model, status, tokens, duration), newest first, up to 100 rows.\n\nUse when: audit individual requests; find expensive or failing calls.\nRisk: read.",
      inputSchema: z.object({ range: PERIOD.default("30d") }),
      outputSchema: DATA_OUTPUT,
      annotations: READ_ONLY,
    },
    async (args) => {
      const guard = needsUser(env);
      if ("error" in guard) return guard.error;
      const result = await call("list usage rows", env.context.web.analytics.getUsageRows(guard.userId, args));
      return "value" in result ? jsonResult(result.value) : result.error;
    }
  );
}
