import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { DATA_OUTPUT, READ_ONLY, WRITE, call, jsonResult, needsUser, type ToolEnv } from "@opendum/api/mcp/tools/shared";

export function registerSessionTools(server: McpServer, env: ToolEnv): void {
  server.registerTool(
    "session_read",
    {
      title: "Session",
      description:
        "Read the session context: user id, points balance, and sharing setting for the key owner.\n\nUse when: orient in the MCP session; find who the key belongs to.\nRisk: read.",
      outputSchema: DATA_OUTPUT,
      annotations: READ_ONLY,
    },
    async () => {
      const guard = needsUser(env);
      if ("error" in guard) return guard.error;
      const pointsResult = await call("read balance", env.context.web.points.pointStatus(guard.userId));
      if ("error" in pointsResult) return pointsResult.error;
      const sharingResult = await call("read sharing", env.context.web.sharing.sharingEnabled(guard.userId));
      if ("error" in sharingResult) return sharingResult.error;
      return jsonResult({
        userId: guard.userId,
        points: pointsResult.value,
        sharing: { enabled: sharingResult.value },
      });
    }
  );

  server.registerTool(
    "sharing_read",
    {
      title: "Sharing status",
      description:
        "Read whether account sharing is enabled for the key owner. Sharing lets other users spend against your accounts' quota.\n\nUse when: check the sharing state before toggling it.\nRisk: read.",
      outputSchema: DATA_OUTPUT,
      annotations: READ_ONLY,
    },
    async () => {
      const guard = needsUser(env);
      if ("error" in guard) return guard.error;
      const result = await call("read sharing", env.context.web.sharing.sharingEnabled(guard.userId));
      return "value" in result ? jsonResult(result.value) : result.error;
    }
  );

  server.registerTool(
    "sharing_update",
    {
      title: "Update sharing",
      description:
        "Enable or disable account sharing for the key owner. Sharing affects how other users' requests can use your accounts.\n\nUse when: open or close your accounts to shared traffic.\nRisk: write.",
      inputSchema: z.object({ enabled: z.boolean() }),
      outputSchema: DATA_OUTPUT,
      annotations: WRITE,
    },
    async (args) => {
      const guard = needsUser(env);
      if ("error" in guard) return guard.error;
      const result = await call("update sharing", env.context.web.sharing.setSharing(guard.userId, args.enabled));
      return "value" in result ? jsonResult(result.value) : result.error;
    }
  );
}
