import { clear, del, entries, set } from "idb-keyval";

const CACHE_VERSION = 1;
const CACHE_DB_NAME = "opendum-dashboard";
const CACHE_STORE_NAME = "async-data";
const CACHE_KEY_PREFIX = `v${CACHE_VERSION}:`;

type DataCacheEntry<T> = {
  value: T;
  cachedAt: number;
};

const dataCacheStore = createIdbStore(CACHE_DB_NAME, CACHE_STORE_NAME);
const memoryCache = new Map<string, DataCacheEntry<unknown>>();

function cacheKey(key: string) {
  return `${CACHE_KEY_PREFIX}${key}`;
}

export function readDataCacheEntry<T>(key: string): DataCacheEntry<T> | undefined {
  return memoryCache.get(key) as DataCacheEntry<T> | undefined;
}

export function readDataCache<T>(key: string): T | undefined {
  return readDataCacheEntry<T>(key)?.value;
}

export function writeDataCache<T>(key: string, value: T): void {
  const entry: DataCacheEntry<T> = { value, cachedAt: Date.now() };
  memoryCache.set(key, entry);

  if (!dataCacheStore) return;

  void set(cacheKey(key), entry, dataCacheStore).catch((error) => {
    console.warn("Failed to persist dashboard data:", error);
  });
}

export function clearDataCache(): void {
  memoryCache.clear();

  if (!dataCacheStore) return;

  void clear(dataCacheStore).catch((error) => {
    console.warn("Failed to clear dashboard data cache:", error);
  });
}

export function removeDataCache(keys: string | string[]): void {
  const keyList = Array.isArray(keys) ? keys : [keys];

  for (const key of keyList) {
    memoryCache.delete(key);
    if (!dataCacheStore) continue;

    void del(cacheKey(key), dataCacheStore).catch((error) => {
      console.warn("Failed to remove cached dashboard data:", error);
    });
  }
}

export async function hydrateDataCache(): Promise<void> {
  if (!dataCacheStore) return;

  try {
    const cachedEntries = await entries<string, DataCacheEntry<unknown>>(dataCacheStore);

    for (const [key, entry] of cachedEntries) {
      if (!key.startsWith(CACHE_KEY_PREFIX) || !entry || typeof entry.cachedAt !== "number") continue;
      memoryCache.set(key.slice(CACHE_KEY_PREFIX.length), entry);
    }
  } catch (error) {
    console.warn("Failed to hydrate dashboard data cache:", error);
  }
}
