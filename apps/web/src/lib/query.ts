import { createSignal, type Accessor } from "solid-js";

export interface QueryEntry<T> {
  data: Accessor<T | undefined>;
  error: Accessor<unknown>;
  pending: Accessor<boolean>;
  setData: (next: T) => void;
  load: (options?: { force?: boolean }) => Promise<void>;
  refresh: () => Promise<void>;
}

export interface QueryOptions<T> {
  defaultValue?: T;
  immediate?: boolean;
}

const registry = new Map<string, QueryEntry<unknown>>();

function createEntry<T>(key: string, fetcher: () => Promise<T>, options: QueryOptions<T>): QueryEntry<T> {
  const [data, setData] = createSignal<T | undefined>(options.defaultValue);
  const [error, setError] = createSignal<unknown>(undefined);
  const [pending, setPending] = createSignal(false);
  let inFlight: Promise<void> | null = null;
  let started = false;

  const run = async (): Promise<void> => {
    setPending(true);
    try {
      const value = await fetcher();
      setData(() => value);
      setError(undefined);
    } catch (cause) {
      setError(cause);
    } finally {
      setPending(false);
    }
  };

  const load = (loadOptions: { force?: boolean } = {}): Promise<void> => {
    if (inFlight && !loadOptions.force) return inFlight;
    if (started && !loadOptions.force) return Promise.resolve();
    started = true;
    inFlight = run().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  const entry: QueryEntry<T> = {
    data,
    error,
    pending,
    setData: (next: T) => {
      setData(() => next);
    },
    load,
    refresh: () => load({ force: true }),
  };

  registry.set(key, entry as QueryEntry<unknown>);

  if (options.immediate !== false) void load();

  return entry;
}

export function createQuery<T>(key: string, fetcher: () => Promise<T>, options: QueryOptions<T> = {}): QueryEntry<T> {
  const existing = registry.get(key) as QueryEntry<T> | undefined;
  return existing ?? createEntry(key, fetcher, options);
}

export function queryEntry<T>(key: string): QueryEntry<T> | undefined {
  return registry.get(key) as QueryEntry<T> | undefined;
}

export function patchQuery<T>(key: string, patcher: (value: T) => T): void {
  const entry = registry.get(key) as QueryEntry<T> | undefined;
  if (!entry) return;

  const current = entry.data();
  if (current === undefined) return;

  entry.setData(patcher(current));
}

export function refreshQueries(keys: string | string[]): Promise<void> {
  const list = Array.isArray(keys) ? keys : [keys];
  return Promise.all(list.map((key) => registry.get(key)?.refresh() ?? Promise.resolve())).then(() => undefined);
}

export function clearQueries(keys: string | string[]): void {
  const list = Array.isArray(keys) ? keys : [keys];
  for (const key of list) registry.delete(key);
}
