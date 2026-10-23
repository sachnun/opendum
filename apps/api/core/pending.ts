import { Duration, Effect, Exit, FiberSet, Option, Scope } from "effect";

/**
 * Fire-and-forget writes that must survive a shutdown. Everything tracked here is
 * already best effort, so failures are swallowed and a drain never rejects.
 *
 * Tracking happens at the `Effect` level: work is forked into a `FiberSet` that
 * owns a dedicated scope, so the drain waits on real fibers instead of ad hoc
 * promises, and a stuck fiber is interrupted when the drain gives up.
 */
let registry: FiberSet.FiberSet<unknown, unknown> | null = null;
let registryScope: Scope.Closeable | null = null;

function registryOf(): FiberSet.FiberSet<unknown, unknown> {
  if (registry) return registry;
  const scope = Scope.makeUnsafe("parallel");
  const set = Effect.runSync(FiberSet.make().pipe(Effect.provideService(Scope.Scope, scope)));
  registryScope = scope;
  registry = set;
  return set;
}

/** Forks best-effort work onto the tracked fiber set. */
export function trackWork(effect: Effect.Effect<unknown>): void {
  const set = registryOf();
  Effect.runFork(FiberSet.run(set, Effect.ignore(effect)));
}

/** Tracks an existing promise, for callers still shaped around promises. */
export function trackPending(task: Promise<unknown>): void {
  trackWork(Effect.promise(() => task.then(() => undefined, () => undefined)));
}

export function pendingTaskCount(): number {
  const set = registry;
  if (!set) return 0;
  return Effect.runSync(FiberSet.size(set));
}

export async function settlePendingTasks(timeoutMs: number): Promise<boolean> {
  const set = registry;
  const scope = registryScope;
  if (!set || !scope) return true;
  const drain = FiberSet.awaitEmpty(set).pipe(Effect.as(true));
  const program =
    timeoutMs > 0
      ? drain.pipe(
          Effect.timeoutOption(Duration.millis(timeoutMs)),
          Effect.map(Option.getOrElse(() => false))
        )
      : drain;
  const drained = await Effect.runPromise(program.pipe(Effect.orElseSucceed(() => false)));
  if (!drained) {
    await Effect.runPromise(Effect.ignore(Scope.close(scope, Exit.void)));
    registry = null;
    registryScope = null;
  }
  return drained;
}
