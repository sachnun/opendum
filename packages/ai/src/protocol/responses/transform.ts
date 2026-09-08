export function messagesToResponsesInput(messages: any[]): any[] {
  const input: any[] = [];

  for (const msg of messages) {
    const role = msg.role || "user";
    const content = msg.content;

    switch (role) {
      case "system":
      case "developer":
        input.push({ type: "message", role: "developer", content });
        break;
      case "user":
        input.push({ type: "message", role: "user", content });
        break;
      case "assistant":
        if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
          if (content) {
            input.push({ type: "message", role: "assistant", content });
          }
          for (const call of msg.tool_calls) {
            const name = call.function?.name;
            if (!name) continue;
            const id = call.id || `call_${Date.now()}`;
            input.push({
              type: "function_call",
              id,
              call_id: id,
              name,
              arguments: call.function?.arguments || "{}",
            });
          }
        } else {
          input.push({ type: "message", role: "assistant", content });
        }
        break;
      case "tool":
        input.push({
          type: "function_call_output",
          call_id: msg.tool_call_id,
          output: typeof content === "string" ? content : JSON.stringify(content || ""),
        });
        break;
      default:
        input.push({ type: "message", role, content });
        break;
    }
  }

  return input;
}

export function responsesInputToMessages(input: any[]): any[] {
  const messages: any[] = [];

  for (const item of input) {
    if (item.type === "message" || !item.type) {
      messages.push({
        role: item.role === "developer" ? "system" : item.role || "user",
        content: item.content,
      });
    } else if (item.type === "function_call") {
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: item.id || item.call_id,
            type: "function",
            function: {
              name: item.name,
              arguments: item.arguments,
            },
          },
        ],
      });
    } else if (item.type === "function_call_output") {
      messages.push({
        role: "tool",
        tool_call_id: item.call_id || item.id,
        content: item.output,
      });
    }
  }

  return messages;
}
