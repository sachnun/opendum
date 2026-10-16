import { Cause, Effect, Option } from "effect";
import { Atom, AsyncResult, Reactivity } from "effect/reactivity";
import type * as AtomRegistry from "effect/reactivity/AtomRegistry";

export type QueryHandler<T> = () => Promise<T>;

export const QUERY_STALE_TIME = "30 seconds";

const runtime = Atom.runtime(Reactivity.layer);

const registeredKeys = new Set<string>();

const handlerAtom = Atom.family((_key: string) => Atom.make<QueryHandler<unknown> | undefined>(undefined));

export function registerQueryHandler<T>(registry: AtomRegistry.AtomRegistry, key: string, handler: QueryHandler<T>): void {
  registeredKeys.add(key);
  registry.set(handlerAtom(key), handler as QueryHandler<unknown>);
}

export function registeredQueryKeys(): string[] {
  return Array.from(registeredKeys);
}

const baseQuery = Atom.family((key: string) =>
  Atom.withReactivity([key])(
    runtime.atom((get) =>
      Effect.suspend(() => {
        const handler = get(handlerAtom(key));
        if (!handler) return Effect.never;
        return Effect.tryPromise({
          try: () => handler(),
          catch: (error) => error,
        });
      })
    )
  )
);

const revalidatingQuery = Atom.family((key: string) =>
  Atom.swr(baseQuery(key), {
    staleTime: QUERY_STALE_TIME,
    revalidateOnFocus: true,
    focusSignal: Atom.windowFocusSignal,
  })
);

export const queryAtom = Atom.family((key: string) =>
  Atom.writable<AsyncResult.AsyncResult<unknown, unknown>, unknown>(
    (get) => get(revalidatingQuery(key)),
    (ctx, value) => {
      ctx.setSelf(AsyncResult.success(value));
    }
  )
);

export function queryValue<T>(registry: AtomRegistry.AtomRegistry, key: string): T | undefined {
  const result = registry.get(queryAtom(key));
  if (AsyncResult.isSuccess(result)) return result.value as T;
  if (AsyncResult.isFailure(result)) {
    return Option.getOrUndefined(Option.map(result.previousSuccess, (success) => success.value)) as T | undefined;
  }
  return undefined;
}

export function queryError(registry: AtomRegistry.AtomRegistry, key: string): unknown {
  const result = registry.get(queryAtom(key));
  return AsyncResult.isFailure(result) ? Cause.squash(result.cause) : undefined;
}

export function queryPending(registry: AtomRegistry.AtomRegistry, key: string): boolean {
  const result = registry.get(queryAtom(key));
  return AsyncResult.isInitial(result) || AsyncResult.isWaiting(result);
}

const invalidateFn = runtime.fn((keys: string[]) => Reactivity.invalidate(keys));

export function invalidateQueries(registry: AtomRegistry.AtomRegistry, keys: string | string[]): void {
  const keyList = Array.isArray(keys) ? keys : [keys];
  if (keyList.length > 0) registry.set(invalidateFn, keyList);
}

export function refreshQueries(registry: AtomRegistry.AtomRegistry, keys: string | string[]): void {
  for (const key of Array.isArray(keys) ? keys : [keys]) registry.refresh(baseQuery(key));
}

export function invalidateAllQueries(registry: AtomRegistry.AtomRegistry): void {
  invalidateQueries(registry, registeredQueryKeys());
}

export function patchQueryValue<T>(registry: AtomRegistry.AtomRegistry, key: string, patcher: (value: T) => T): void {
  const current = queryValue<T>(registry, key);
  if (current === undefined) return;
  registry.set(queryAtom(key), patcher(current));
}

export function setQueryValue<T>(registry: AtomRegistry.AtomRegistry, key: string, value: T): void {
  registry.set(queryAtom(key), value);
}
