type Json = Record<string, unknown>;

export function stripImageContent(payload: Json): void {
  const messages = payload.messages;
  if (Array.isArray(messages)) {
    for (const item of messages) {
      const message = item as Json;
      if (!Array.isArray(message.content)) continue;
      const filtered = filterImageParts(message.content);
      if (filtered.length === 1) {
        const textPart = filtered[0] as Json;
        if (textPart.type === "text" && typeof textPart.text === "string") {
          message.content = textPart.text;
          continue;
        }
      }
      message.content = filtered;
    }
  }

  const responsesInput = payload._responsesInput;
  if (!Array.isArray(responsesInput)) return;
  for (const raw of responsesInput) {
    const item = raw as Json;
    if (!Array.isArray(item.content)) continue;
    item.content = filterImageParts(item.content);
  }
}

function filterImageParts(content: unknown[]): unknown[] {
  const filtered: unknown[] = [];
  for (const part of content) {
    if (part === null || typeof part !== "object" || Array.isArray(part)) {
      filtered.push(part);
      continue;
    }
    const type = (part as Json).type;
    if (type === "image_url" || type === "image" || type === "input_image") continue;
    filtered.push(part);
  }
  return filtered;
}
