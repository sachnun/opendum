export function stripImageContent(payload: Record<string, unknown>): void {
  const messages = payload["messages"];
  if (Array.isArray(messages)) {
    for (const item of messages) {
      if (!item || typeof item !== "object") continue;
      const message = item as Record<string, unknown>;
      const content = message["content"];
      if (!Array.isArray(content)) continue;
      const filtered = filterImageParts(content);
      if (filtered.length === 1) {
        const textPart = filtered[0];
        if (textPart && typeof textPart === "object") {
          const tp = textPart as Record<string, unknown>;
          if (tp["type"] === "text") {
            if (typeof tp["text"] === "string") {
              message["content"] = tp["text"];
              continue;
            }
          }
        }
      }
      message["content"] = filtered;
    }
  }

  const responsesInput = payload["_responsesInput"];
  if (!Array.isArray(responsesInput)) return;
  for (const raw of responsesInput) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const content = item["content"];
    if (!Array.isArray(content)) continue;
    item["content"] = filterImageParts(content);
  }
}

export function filterImageParts(content: unknown[]): unknown[] {
  const filtered: unknown[] = [];
  for (const part of content) {
    if (part && typeof part === "object") {
      const partMap = part as Record<string, unknown>;
      const typeValue = typeof partMap["type"] === "string" ? (partMap["type"] as string) : "";
      if (typeValue === "image_url" || typeValue === "image" || typeValue === "input_image") {
        continue;
      }
    }
    filtered.push(part);
  }
  return filtered;
}

export function stripToolCallParameters(payload: Record<string, unknown>): void {
  delete payload["tools"];
  delete payload["tool_choice"];
  delete payload["parallel_tool_calls"];
}
