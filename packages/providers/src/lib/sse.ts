import { createParser, type EventSourceMessage } from "eventsource-parser";

export async function* sseDataLines(source: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = source.getReader();
  const decoder = new TextDecoder();
  const pending: string[] = [];
  const parser = createParser({
    onEvent: (message: EventSourceMessage) => {
      if (message.data !== "") pending.push(message.data);
    },
  });

  const drain = function* (): Generator<string> {
    while (pending.length > 0) yield pending.shift() as string;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.feed(decoder.decode(value, { stream: true }));
      yield* drain();
    }
    const tail = decoder.decode();
    if (tail) parser.feed(tail);
    parser.feed("\n\n");
    yield* drain();
  } finally {
    reader.releaseLock();
  }
}
