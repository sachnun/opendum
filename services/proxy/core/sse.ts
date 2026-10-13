export type SseEvent = { data: string };

export class SseScanner {
  private buffer = "";

  process(chunk: string, handle: (event: SseEvent) => void): void {
    this.buffer += chunk.replace(/\r\n/g, "\n");
    const events = this.buffer.split("\n\n");
    this.buffer = events[events.length - 1] ?? "";
    for (const event of events.slice(0, -1)) {
      processSseLines(event.split("\n"), handle);
    }
  }

  flush(handle: (event: SseEvent) => void): void {
    if (this.buffer.trim() !== "") {
      processSseLines(this.buffer.split("\n"), handle);
    }
    this.buffer = "";
  }
}

function processSseLines(lines: string[], handle: (event: SseEvent) => void): void {
  const data: string[] = [];
  for (const line of lines) {
    if (line.startsWith("data:")) data.push(line.slice("data:".length).trim());
  }
  if (data.length === 0) return;
  const payload = data.join("\n");
  if (payload !== "" && payload !== "[DONE]") handle({ data: payload });
}
