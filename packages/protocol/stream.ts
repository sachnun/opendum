import { emptyUsage, type IrEvent, type IrRequest } from "@opendum/protocol/ir";
import { SseReader, formatSse, type SseEvent } from "@opendum/protocol/sse";
import { mergeUsage } from "@opendum/protocol/usage";
import type { StreamCodec, StreamEncoder, StreamEvent } from "@opendum/protocol/upstream";

const encoder = new TextEncoder();

export async function* upstreamEvents(
  source: ReadableStream<Uint8Array>,
  decoder: StreamCodec
): AsyncGenerator<IrEvent> {
  const reader = new SseReader(source);
  for (;;) {
    const event = await reader.next();
    if (!event) break;
    if (event.data.trim() === "[DONE]") break;
    for (const decoded of decoder.decode(event)) yield decoded;
  }
  yield decoder.finish();
}

export function encodeEvents(
  events: AsyncIterable<IrEvent>,
  codec: StreamEncoder
): ReadableStream<Uint8Array> {
  const iterator = events[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        const result = await iterator.next();
        if (result.done) {
          controller.close();
          return;
        }
        const chunks = codec.encode(result.value);
        if (chunks.length === 0) continue;
        for (const chunk of chunks) controller.enqueue(encoder.encode(formatSse(toSse(chunk))));
        return;
      }
    },
    async cancel() {
      await iterator.return?.(undefined);
    },
  });
}

export function encodeEventList(events: ReadonlyArray<IrEvent>, codec: StreamEncoder): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (const event of events) {
    for (const chunk of codec.encode(event)) chunks.push(encoder.encode(formatSse(toSse(chunk))));
  }
  return chunks;
}

function toSse(event: StreamEvent): SseEvent {
  return { event: event.event, data: event.data, id: "" };
}

export function isStream(request: IrRequest): boolean {
  return request.stream;
}

export function streamEvents(
  source: ReadableStream<Uint8Array>,
  decoder: StreamCodec,
  codec: StreamEncoder
): ReadableStream<Uint8Array> {
  return encodeEvents(upstreamEvents(source, decoder), codec);
}

export class UsageCollector {
  private value = emptyUsage();

  observe(event: IrEvent): void {
    if (event.type !== "finish") return;
    this.value = mergeUsage(this.value, event.usage);
  }

  usage(): ReturnType<typeof emptyUsage> {
    return this.value;
  }
}

export type { StreamEvent };
