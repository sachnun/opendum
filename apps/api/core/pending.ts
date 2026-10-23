import { Effect } from "effect";

const tasks = new Set<Promise<void>>();

export function trackPending(task: Promise<unknown>): void {
  const tracked: Promise<void> = task.then(
    () => undefined,
    () => undefined
  ).finally(() => {
    tasks.delete(tracked);
  });
  tasks.add(tracked);
}

export function trackWork(effect: Effect.Effect<unknown>): void {
  trackPending(Effect.runPromise(effect));
}

export function pendingTaskCount(): number {
  return tasks.size;
}

export async function settlePendingTasks(timeoutMs: number): Promise<boolean> {
  if (tasks.size === 0) return true;
  const drained = (async (): Promise<boolean> => {
    while (tasks.size > 0) {
      await Promise.allSettled(tasks);
    }
    return true;
  })();
  if (timeoutMs <= 0) {
    await drained;
    return true;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref?.();
  });
  const result = await Promise.race([drained, timedOut]);
  if (timer !== undefined) clearTimeout(timer);
  return result;
}
