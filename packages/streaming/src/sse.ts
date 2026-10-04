import { createParser, type EventSourceMessage } from "eventsource-parser";

export type SseEvent = {
  event?: string;
  data: string;
  id?: string;
  retry?: number;
};

export type SseHandler = (event: SseEvent) => void | Promise<void>;

export async function readSse(
  stream: ReadableStream<Uint8Array>,
  onEvent: SseHandler
): Promise<void> {
  const decoder = new TextDecoder();
  const pending: Promise<void>[] = [];
  const parser = createParser({
    onEvent: (event: EventSourceMessage) => {
      const normalized: SseEvent = { data: event.data };
      if (event.event !== undefined) normalized.event = event.event;
      if (event.id !== undefined) normalized.id = event.id;
      const result = onEvent(normalized);
      if (result instanceof Promise) pending.push(result);
    },
  });

  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) parser.feed(decoder.decode(value, { stream: true }));
    }
    parser.feed(decoder.decode());
  } finally {
    reader.releaseLock();
  }

  await Promise.all(pending);
}

export async function* iterateSse(stream: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const queue: SseEvent[] = [];
  let notify: (() => void) | null = null;
  let finished = false;
  let failure: unknown = null;

  const run = readSse(stream, (event) => {
    queue.push(event);
    notify?.();
  })
    .catch((error: unknown) => {
      failure = error;
    })
    .finally(() => {
      finished = true;
      notify?.();
    });

  while (!finished || queue.length > 0) {
    if (queue.length === 0) {
      await new Promise<void>((resolve) => {
        notify = resolve;
      });
      notify = null;
      continue;
    }
    yield queue.shift() as SseEvent;
  }

  await run;
  if (failure) throw failure;
}

export function encodeSse(event: SseEvent): string {
  const lines: string[] = [];
  if (event.event) lines.push(`event: ${event.event}`);
  if (event.id) lines.push(`id: ${event.id}`);
  if (event.retry !== undefined) lines.push(`retry: ${event.retry}`);
  for (const line of event.data.split("\n")) {
    lines.push(`data: ${line}`);
  }
  return `${lines.join("\n")}\n\n`;
}
