import type { MaybeRefOrGetter, WatchSource } from "vue";

type CachedDataOptions<T> = {
  default?: () => T;
  watch?: WatchSource[];
  deep?: boolean;
  immediate?: boolean;
  refreshOnMount?: boolean;
  staleTimeMs?: number;
};

const CACHE_STALE_MS = 30_000;

export function useCachedData<T>(
  key: MaybeRefOrGetter<string>,
  handler: () => Promise<T>,
  options: CachedDataOptions<T> = {}
) {
  const staleTimeMs = options.staleTimeMs ?? CACHE_STALE_MS;
  const currentKey = () => toValue(key);
  const seededEntry = import.meta.client ? readDataCacheEntry<T>(currentKey()) : undefined;

  const asyncData = useAsyncData<T>(currentKey, async () => {
    const handlerKey = currentKey();
    const value = await handler();
    writeDataCache(handlerKey, value);
    return value;
  }, {
    deep: options.deep ?? false,
    immediate: options.immediate ?? true,
    getCachedData: (cacheKey, _nuxtApp, context) => (context.cause === "initial" ? readDataCache<T>(cacheKey) : undefined),
    ...(options.default ? { default: options.default } : {}),
    watch: options.watch,
  });

  if (import.meta.client) {
    watch(asyncData.data, (value) => {
      if (value !== undefined) writeDataCache(currentKey(), value);
    });

    if (options.refreshOnMount !== false) {
      onMounted(() => {
        if (!seededEntry) return;
        if (Date.now() - seededEntry.cachedAt < staleTimeMs) return;
        void asyncData.refresh({ cause: "refresh:manual" });
      });
    }

    if (isRef(key) || typeof key === "function") {
      watch(key, (nextKey) => {
        const entry = readDataCacheEntry<T>(nextKey);
        if (!entry || Date.now() - entry.cachedAt < staleTimeMs) return;
        void asyncData.refresh({ cause: "refresh:manual" });
      }, { flush: "post" });
    }
  }

  return asyncData;
}
