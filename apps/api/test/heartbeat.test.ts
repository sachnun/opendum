import { describe, expect, it } from "bun:test";
import { withHeartbeat } from "@opendum/api/proxy/heartbeat";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function chunked(parts: Array<{ text: string; delayMs?: number }>): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const part = parts[index];
      if (!part) {
        controller.close();
        return;
      }
      index += 1;
      if (part.delayMs) await Bun.sleep(part.delayMs);
      controller.enqueue(encoder.encode(part.text));
    },
  });
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

describe("withHeartbeat", () => {
  it("returns the source untouched when disabled", () => {
    const source = chunked([{ text: "a" }]);
    expect(withHeartbeat(source, 0)).toBe(source);
  });

  it("emits keep-alive comments while the source is silent", async () => {
    const stream = withHeartbeat(chunked([{ text: "data: a\n\n" }, { text: "data: b\n\n", delayMs: 90 }]), 20);
    const text = await readAll(stream);
    expect(text).toMatch(/data: a/);
    expect(text).toMatch(/data: b/);
    expect(text.match(/: keep-alive/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("does not emit heartbeats for a busy stream", async () => {
    const stream = withHeartbeat(chunked([{ text: "a" }, { text: "b" }, { text: "c" }]), 200);
    const text = await readAll(stream);
    expect(text).toBe("abc");
  });

  it("closes after the source ends", async () => {
    const stream = withHeartbeat(chunked([{ text: "only" }]), 1000);
    expect(await readAll(stream)).toBe("only");
  });

  it("stops the timer when the consumer cancels", async () => {
    const stream = withHeartbeat(chunked([{ text: "a" }, { text: "b", delayMs: 5000 }]), 10);
    const reader = stream.getReader();
    const first = await reader.read();
    expect(decoder.decode(first.value)).toBe("a");
    await reader.cancel();
  });
});
