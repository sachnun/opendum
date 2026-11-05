export type SseEvent = {
  event: string;
  data: string;
  id: string;
};

export const SSE_DONE = "[DONE]";

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function parseBlock(block: string): SseEvent | null {
  const lines = block.split("\n");
  const data: string[] = [];
  let event = "";
  let id = "";
  for (const line of lines) {
    if (!line || line.startsWith(":")) continue;
    const index = line.indexOf(":");
    const field = index < 0 ? line : line.slice(0, index);
    let value = index < 0 ? "" : line.slice(index + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") data.push(value);
    else if (field === "event") event = value;
    else if (field === "id") id = value;
  }
  if (data.length === 0) return null;
  return { event, data: data.join("\n"), id };
}

export class SseDecoder {
  private buffer = "";

  process(chunk: string, handle: (event: SseEvent) => void): void {
    this.buffer += chunk.replace(/\r\n/g, "\n");
    const blocks = this.buffer.split("\n\n");
    this.buffer = blocks[blocks.length - 1] ?? "";
    for (const block of blocks.slice(0, -1)) {
      const event = parseBlock(block);
      if (event) handle(event);
    }
  }

  flush(handle: (event: SseEvent) => void): void {
    if (this.buffer.trim() !== "") {
      const event = parseBlock(this.buffer);
      if (event) handle(event);
    }
    this.buffer = "";
  }
}

export class SseReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;

  private readonly scanner = new SseDecoder();

  private readonly queue: SseEvent[] = [];

  private finished = false;

  constructor(body: ReadableStream<Uint8Array>) {
    this.reader = body.getReader();
  }

  async next(): Promise<SseEvent | null> {
    for (;;) {
      const queued = this.queue.shift();
      if (queued) return queued;
      if (this.finished) return null;
      const { done, value } = await this.reader.read();
      if (done) {
        this.finished = true;
        this.scanner.flush((event) => this.queue.push(event));
        continue;
      }
      this.scanner.process(decoder.decode(value, { stream: true }), (event) => this.queue.push(event));
    }
  }

  async close(): Promise<void> {
    this.finished = true;
    await this.reader.cancel();
  }
}

export function formatSse(event: { event: string; data: string; id?: string }): string {
  const lines: string[] = [];
  if (event.event) lines.push(`event: ${event.event}`);
  for (const line of event.data.split("\n")) lines.push(`data: ${line}`);
  if (event.id) lines.push(`id: ${event.id}`);
  return `${lines.join("\n")}\n\n`;
}

export function encodeSse(event: SseEvent): Uint8Array {
  return encoder.encode(formatSse(event));
}

export function dataEvent(data: string): SseEvent {
  return { event: "", data, id: "" };
}

export function isDone(event: SseEvent): boolean {
  return event.data.trim() === SSE_DONE;
}
