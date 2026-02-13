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

export function convertResponsesInputToChatMessages(
  input: Array<Record<string, unknown>>,
  instructions?: string
): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [];

  if (instructions) {
    messages.push({ role: "system", content: instructions });
  }

  const pendingToolCalls: Array<Record<string, unknown>> = [];

  for (const item of input) {
    const type = item.type;
    if (typeof type !== "string") {
      continue;
    }

    if (type === "message") {
      if (pendingToolCalls.length > 0) {
        messages.push({
          role: "assistant",
          content: "",
          tool_calls: [...pendingToolCalls],
        });
        pendingToolCalls.length = 0;
      }

      const role = typeof item.role === "string" ? item.role : "user";
      const content = item.content;

      if (role === "developer") {
        messages.push({
          role: "system",
          content:
            typeof content === "string"
              ? content
              : content === undefined
                ? ""
                : JSON.stringify(content),
        });
      } else {
        messages.push({
          role,
          content:
            typeof content === "string" || Array.isArray(content)
              ? content
              : content === undefined
                ? ""
                : JSON.stringify(content),
        });
      }

      continue;
    }

    if (type === "function_call") {
      const rawId =
        (typeof item.call_id === "string" && item.call_id) ||
        (typeof item.id === "string" && item.id) ||
        `call_${Date.now()}`;

      const normalizedId = rawId.startsWith("fc_")
        ? `call_${rawId.slice(3)}`
        : rawId.startsWith("fc-")
          ? `call_${rawId.slice(3)}`
          : rawId;

      pendingToolCalls.push({
        id: normalizedId,
        type: "function",
        function: {
          name: typeof item.name === "string" ? item.name : "",
          arguments:
            typeof item.arguments === "string"
              ? item.arguments
              : item.arguments === undefined
                ? "{}"
                : JSON.stringify(item.arguments),
        },
      });

      continue;
    }

    if (type === "function_call_output") {
      if (pendingToolCalls.length > 0) {
        messages.push({
          role: "assistant",
          content: "",
          tool_calls: [...pendingToolCalls],
        });
        pendingToolCalls.length = 0;
      }

      const rawCallId = typeof item.call_id === "string" ? item.call_id : "";
      const normalizedCallId = rawCallId.startsWith("fc_")
        ? `call_${rawCallId.slice(3)}`
        : rawCallId.startsWith("fc-")
          ? `call_${rawCallId.slice(3)}`
          : rawCallId;

      messages.push({
        role: "tool",
        tool_call_id: normalizedCallId,
        content:
          typeof item.output === "string"
            ? item.output
            : item.output === undefined
              ? ""
              : JSON.stringify(item.output),
      });
    }
  }

  if (pendingToolCalls.length > 0) {
    messages.push({
      role: "assistant",
      content: "",
      tool_calls: [...pendingToolCalls],
    });
  }

  return messages;
}
