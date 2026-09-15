export function usePrefetch() {
  const api = useApi();
  let started = false;

  function prefetch() {
    if (started || !import.meta.client) return;
    started = true;

    const tasks: Array<[string, () => Promise<unknown>]> = [
      [dataKeys.models, () => api.models.list({ includeStats: false })],
      [dataKeys.playgroundOptions, () => api.playground.options()],
      [dataKeys.apiKeys, async () => {
        const [apiKeys, options] = await Promise.all([api.apiKeys.list(), api.apiKeys.options()]);
        return { apiKeys, options };
      }],
    ];

    for (const [key, run] of tasks) {
      if (readDataCache(key) !== undefined) continue;
      void run().then((value) => writeDataCache(key, value)).catch((error) => {
        console.warn(`Failed to prefetch dashboard data for ${key}:`, error);
      });
    }
  }

  return { prefetch };
}
