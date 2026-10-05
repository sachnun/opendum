import { createParser, type EventSourceMessage } from "eventsource-parser";

export type SseEvent = { data: string };

export class SseScanner {
  private handler: ((event: SseEvent) => void) | null = null;
  private readonly parser = createParser({
    onEvent: (message: EventSourceMessage) => {
      const { data } = message;
      if (data !== "" && data !== "[DONE]") this.handler?.({ data });
    },
  });

  process(chunk: string, handle: (event: SseEvent) => void): void {
    this.handler = handle;
    this.parser.feed(chunk);
  }

  flush(handle: (event: SseEvent) => void): void {
    this.handler = handle;
    this.parser.feed("\n\n");
  }
}
