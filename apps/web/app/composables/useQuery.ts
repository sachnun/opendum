import { Effect } from "effect";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { injectRegistry } from "@effect/atom-vue";
import {
  patchQueryValue,
  queryAtom,
  queryError,
  queryPending,
  queryValue,
  refreshQueries,
  registerQueryHandler,
  setQueryValue,
  type QueryHandler,
} from "../utils/atom";

type QueryOptions<T> = {
  default?: () => T;
  immediate?: boolean;
};

export function useQuery<T>(key: MaybeRefOrGetter<string>, handler: QueryHandler<T>, options: QueryOptions<T> = {}) {
  const registry = injectRegistry();
  const currentKey = () => toValue(key);
  const started = ref(options.immediate ?? true);
  const version = ref(0);

  watchEffect((onCleanup) => {
    if (!started.value) return;
    const activeKey = currentKey();
    registerQueryHandler(registry, activeKey, handler);
    onCleanup(registry.subscribe(queryAtom(activeKey), () => {
      version.value += 1;
    }, { immediate: true }));
  });

  const data = computed<T | undefined>({
    get: () => {
      void version.value;
      return queryValue<T>(registry, currentKey()) ?? options.default?.();
    },
    set: (value) => {
      if (value === undefined) return;
      setQueryValue(registry, currentKey(), value as T);
    },
  });

  const error = computed(() => {
    void version.value;
    return queryError(registry, currentKey());
  });

  const pending = computed(() => {
    void version.value;
    return queryPending(registry, currentKey());
  });

  async function refresh(): Promise<void> {
    const activeKey = currentKey();
    registerQueryHandler(registry, activeKey, handler);
    started.value = true;
    refreshQueries(registry, activeKey);
    await Effect.runPromiseExit(AtomRegistry.getResult(registry, queryAtom(activeKey), { suspendOnWaiting: true }));
  }

  function set(value: T): void {
    setQueryValue(registry, currentKey(), value);
  }

  function patch(patcher: (value: T) => T): void {
    patchQueryValue(registry, currentKey(), patcher);
  }

  return { data, error, pending, refresh, set, patch };
}
