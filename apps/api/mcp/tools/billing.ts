import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { DATA_OUTPUT, READ_ONLY, call, jsonResult, needsUser, type ToolEnv } from "@opendum/api/mcp/tools/shared";

const BALANCE_OUTPUT = z.object({
  balance: z.number(),
  roamingByKey: z.record(z.string(), z.number()),
});

export function registerBillingTools(server: McpServer, env: ToolEnv): void {
  server.registerTool(
    "billing_balance_read",
    {
      title: "Account balance",
      description:
        "Read the remaining opendum points for the key owner, including roaming point balances per API key.\n\nUse when: check whether chat_create can spend points.\nNote: Money amounts are point units, floating-point.\nRisk: read.",
      outputSchema: BALANCE_OUTPUT,
      annotations: READ_ONLY,
    },
    async () => {
      const guard = needsUser(env);
      if ("error" in guard) return guard.error;
      const result = await call("read balance", env.context.web.points.pointStatus(guard.userId));
      if ("error" in result) return result.error;
      return {
        content: [{ type: "text", text: JSON.stringify(result.value, null, 2) }],
        structuredContent: result.value,
      };
    }
  );

  server.registerTool(
    "billing_summary_read",
    {
      title: "Billing summary",
      description:
        "Read the billing summary: remaining points (with roaming by key) after claiming today's daily access points.\n\nUse when: one-call balance plus daily top-up status. Claiming is idempotent, once per day.\nRisk: read.",
      outputSchema: DATA_OUTPUT,
      annotations: READ_ONLY,
    },
    async () => {
      const guard = needsUser(env);
      if ("error" in guard) return guard.error;
      const claimed = await call("claim daily points", env.context.web.points.claimDaily(guard.userId));
      if ("error" in claimed) return claimed.error;
      const status = await call("read balance", env.context.web.points.pointStatus(guard.userId));
      if ("error" in status) return status.error;
      return jsonResult({ ...status.value, dailyClaimed: claimed.value });
    }
  );
}
