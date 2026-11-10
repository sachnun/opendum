import type { Effect } from "effect";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { ModelIdentity } from "@opendum/api/handlers/model-listing";
import type { McpContext } from "@opendum/api/mcp/types";
import { runOutcome } from "@opendum/api/mcp/run";

export type ToolEnv = {
  context: McpContext;
  identity: ModelIdentity;
  authHeader: string;
};

export const JSON_VALUE = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.unknown()),
  z.record(z.string(), z.unknown()),
]);

export const DATA_OUTPUT = z.object({ data: JSON_VALUE });

export const JSON_RECORD = z.record(z.string(), z.unknown());

export const READ_ONLY = { readOnlyHint: true };

export const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };

export const DESTRUCTIVE = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function textError(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

export function jsonResult(value: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: { data: value === undefined ? null : value },
  };
}

export function needsUser(env: ToolEnv): { userId: string } | { error: CallToolResult } {
  if (!env.identity.userId) {
    return { error: textError("No authenticated user for this MCP connection. Use a valid opendum API key.") };
  }
  return { userId: env.identity.userId };
}

export async function call<A>(
  action: string,
  effect: Effect.Effect<A, unknown>
): Promise<{ value: A } | { error: CallToolResult }> {
  const outcome = await runOutcome(effect, action);
  return outcome.ok ? { value: outcome.value } : { error: textError(outcome.message) };
}

export function describeToolUse(use: string, risk: string, note?: string): string {
  return `${use}\n${note ? `Note: ${note}\n` : ""}Risk: ${risk}.`;
}
