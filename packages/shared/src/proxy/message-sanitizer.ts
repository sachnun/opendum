/**
 * Message sanitizer — strips image/multimodal content from messages
 * when the target model only supports text input.
 *
 * Used by the proxy layer to prevent "not a multimodal model" errors
 * from upstream providers (e.g. NVIDIA NIM rejecting image_url parts
 * for text-only models like GLM-5).
 */

import type { ChatCompletionRequest } from "./providers/types.js";

type Message = ChatCompletionRequest["messages"][number];

/**
 * Strip non-text content parts from a messages array.
 *
 * For each message whose `content` is an array of content parts:
 *   - Removes `image_url`, `image`, `input_image`, `audio`, and `video` parts
 *   - Keeps only `text` parts (and any unknown types for forward-compat)
 *   - If only text parts remain, flattens the array to a plain string
 *     (some providers reject the array format for text-only models)
 *   - If no content remains after stripping, sets content to empty string
 *
 * Messages with a plain string `content` are left untouched.
 */
export function stripImageContent(
  messages: Message[]
): Message[] {
  const MULTIMODAL_TYPES = new Set([
    "image_url",
    "image",
    "input_image",
    "audio",
    "video",
  ]);

  return messages.map((msg) => {
    if (!Array.isArray(msg.content)) return msg;

    const textParts = (
      msg.content as Array<{ type: string; text?: string; [key: string]: unknown }>
    ).filter((part) => !MULTIMODAL_TYPES.has(part.type));

    // All parts were multimodal — collapse to empty string
    if (textParts.length === 0) {
      return { ...msg, content: "" };
    }

    // Only text parts remain — flatten to a plain string so providers
    // that reject the array format for text-only models don't choke.
    const allText = textParts.every((p) => p.type === "text");
    if (allText) {
      const joined = textParts
        .map((p) => (typeof p.text === "string" ? p.text : ""))
        .join("");
      return { ...msg, content: joined };
    }

    // Mixed non-image parts — keep the array form
    return { ...msg, content: textParts };
  });
}
