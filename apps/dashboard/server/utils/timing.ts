type TimingMeta = Record<string, unknown>;

export function createServiceTimer(service: string, meta: TimingMeta = {}) {
  const startedAt = Date.now();
  const timings: Record<string, number> = {};

  return {
    async time<T>(key: string, action: () => Promise<T>): Promise<T> {
      const stageStartedAt = Date.now();
      try {
        return await action();
      } finally {
        timings[key] = Date.now() - stageStartedAt;
      }
    },
    record(key: string, stageStartedAt: number) {
      timings[key] = Date.now() - stageStartedAt;
    },
    log(extra: TimingMeta = {}) {
      console.info("dashboard service timing", {
        service,
        ...meta,
        ...extra,
        timings,
        total: Date.now() - startedAt,
      });
    },
  };
}
