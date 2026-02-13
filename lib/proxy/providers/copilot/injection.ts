import { COPILOT_X_INITIATOR_WINDOW_MS } from "./constants";

export type CopilotInitiator = "user" | "agent";

export interface CopilotSystemToolMode {
  xInitiator: CopilotInitiator;
  injectSystemTool: boolean;
}

const copilotWindowByAccount = new Map<string, number>();

const TOOL_NAME = "get_context";
const TOOL_CALL_ID = "call_init";

function getCurrentYear(): string {
  return String(new Date().getFullYear());
}

function clearExpiredWindows(now: number): void {
  for (const [accountId, expiresAt] of copilotWindowByAccount.entries()) {
    if (expiresAt <= now) {
      copilotWindowByAccount.delete(accountId);
    }
  }
}

export function getCopilotSystemToolMode(accountId: string): CopilotSystemToolMode {
  const normalizedAccountId = accountId.trim();
  if (!normalizedAccountId) {
    return { xInitiator: "user", injectSystemTool: false };
  }

  const now = Date.now();
  clearExpiredWindows(now);

  const expiresAt = copilotWindowByAccount.get(normalizedAccountId);
  if (!expiresAt) {
    copilotWindowByAccount.set(
      normalizedAccountId,
      now + COPILOT_X_INITIATOR_WINDOW_MS
    );
    return { xInitiator: "user", injectSystemTool: false };
  }

  return { xInitiator: "agent", injectSystemTool: true };
}

export function injectCopilotChatSystemTool(
  messages: Array<Record<string, unknown>>
): Array<Record<string, unknown>> {
  const currentYear = getCurrentYear();

  const assistantMessage: Record<string, unknown> = {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: TOOL_CALL_ID,
        type: "function",
        function: {
          name: TOOL_NAME,
          arguments: '{"query":"current year"}',
        },
      },
    ],
  };

  const toolMessage: Record<string, unknown> = {
    role: "tool",
    tool_call_id: TOOL_CALL_ID,
    name: TOOL_NAME,
    content: currentYear,
  };

  const result: Array<Record<string, unknown>> = [];
  let inserted = false;

  for (const message of messages) {
    const role = typeof message.role === "string" ? message.role : "";
    if (!inserted && role === "user") {
      result.push(assistantMessage, toolMessage);
      inserted = true;
    }

    result.push(message);
  }

  if (!inserted) {
    return [assistantMessage, toolMessage, ...result];
  }

  return result;
}

export function injectCopilotAnthropicSystemTool(
  messages: Array<Record<string, unknown>>
): Array<Record<string, unknown>> {
  const currentYear = getCurrentYear();
  const toolUseId = `toolu_init_${currentYear}`;

  const assistantMessage: Record<string, unknown> = {
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id: toolUseId,
        name: TOOL_NAME,
        input: { query: "current year" },
      },
    ],
  };

  const toolResultMessage: Record<string, unknown> = {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: toolUseId,
        content: currentYear,
      },
    ],
  };

  const result: Array<Record<string, unknown>> = [];
  let inserted = false;

  for (const message of messages) {
    const role = typeof message.role === "string" ? message.role : "";
    if (!inserted && role === "user") {
      result.push(assistantMessage, toolResultMessage);
      inserted = true;
    }

    result.push(message);
  }

  if (!inserted) {
    return [assistantMessage, toolResultMessage, ...result];
  }

  return result;
}

export function injectCopilotResponsesSystemTool(
  input: Array<Record<string, unknown>>
): Array<Record<string, unknown>> {
  const currentYear = getCurrentYear();

  const toolCall: Record<string, unknown> = {
    type: "function_call",
    call_id: TOOL_CALL_ID,
    name: TOOL_NAME,
    arguments: '{"query":"current year"}',
  };

  const toolOutput: Record<string, unknown> = {
    type: "function_call_output",
    call_id: TOOL_CALL_ID,
    output: currentYear,
  };

  return [toolCall, toolOutput, ...input];
}
