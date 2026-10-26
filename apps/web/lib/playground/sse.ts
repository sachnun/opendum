import { createParser, type EventSourceMessage } from "eventsource-parser";
import { parseJson, raise } from "~~/lib/settle";
import { Completion, Tokens } from "~~/lib/playground/parsing";
import type { ParsedCompletionData, PlaygroundEndpoint } from "~~/lib/playground/types";

export class Sse {
  static handle(
    message: EventSourceMessage,
    onChunk: (chunk: ParsedCompletionData) => void,
    endpoint: PlaygroundEndpoint
  ): boolean {
    const data = message.data.trim();
    if (!data || data === "[DONE]") return false;

    const parsed = parseJson(data);
    if (parsed === null) return false;

    const errorMessage = Completion.error(parsed);
    if (errorMessage) raise(new Error(errorMessage));

    const eventName =
      message.event ??
      (parsed && typeof parsed === "object" && typeof (parsed as { type?: unknown }).type === "string"
        ? (parsed as { type: string }).type
        : "");
    const chunk =
      endpoint === "messages"
        ? Completion.anthropicStream(eventName, parsed)
        : endpoint === "responses"
          ? Completion.responsesStream(parsed)
          : Completion.streamChunk(parsed);
    if (!chunk.content && !chunk.reasoning && chunk.toolCalls.length === 0 && !chunk.usage) return false;

    onChunk(chunk);
    return true;
  }

  static processor(endpoint: PlaygroundEndpoint, onChunk: (chunk: ParsedCompletionData) => void) {
    let emitted = 0;
    const parser = createParser({
      onEvent: (message) => {
        if (Sse.handle(message, onChunk, endpoint)) emitted += 1;
      },
    });

    return {
      feed(chunk: string) {
        emitted = 0;
        parser.feed(chunk);
        return emitted;
      },
      flush() {
        emitted = 0;
        parser.reset({ consume: true });
        return emitted;
      },
    };
  }

  static ok(status: number): boolean {
    return status >= 200 && status < 300;
  }

  static usage(payload: unknown) {
    return Tokens.usage(payload);
  }
}
