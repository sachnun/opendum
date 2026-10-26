const encoder = new TextEncoder();

export const STREAM_HEARTBEAT_MS = 15 * 1000;

export const SSE_KEEPALIVE = encoder.encode(": keep-alive\n\n");

type ReadResult = { done: boolean; value?: Uint8Array };

export function withHeartbeat(
  source: ReadableStream<Uint8Array>,
  intervalMs: number
): ReadableStream<Uint8Array> {
  if (intervalMs <= 0) return source;
  const reader = source.getReader();
  let pending: Promise<ReadResult> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let finished = false;

  const clearTimer = (): void => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  };

  const nextChunk = (): Promise<ReadResult> => {
    if (pending === null) {
      pending = reader.read().then(
        (result): ReadResult => ({ done: result.done, value: result.value }),
        (error) => {
          throw error;
        }
      );
    }
    return pending;
  };

  const tick = (): Promise<"tick"> =>
    new Promise<"tick">((resolve) => {
      timer = setTimeout(() => {
        timer = null;
        resolve("tick");
      }, intervalMs);
    });

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (finished) return;
      const outcome = await Promise.race([nextChunk(), tick()]);
      clearTimer();
      if (outcome === "tick") {
        if (finished) return;
        controller.enqueue(SSE_KEEPALIVE);
        return;
      }
      pending = null;
      if (outcome.done) {
        finished = true;
        reader.releaseLock();
        controller.close();
        return;
      }
      if (outcome.value) controller.enqueue(outcome.value);
    },
    cancel(reason) {
      finished = true;
      clearTimer();
      return reader.cancel(reason);
    },
  });
}
