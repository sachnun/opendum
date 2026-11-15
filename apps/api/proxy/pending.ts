import { Duration, Effect, Exit, FiberSet, Option, Scope } from "effect";

const registryState: {
  set?: FiberSet.FiberSet<unknown, unknown>;
  scope?: Scope.Closeable;
} = {};

function registryOf(): FiberSet.FiberSet<unknown, unknown> {
  if (registryState.set) return registryState.set;
  const scope = Scope.makeUnsafe("parallel");
  const set = Effect.runSync(FiberSet.make().pipe(Effect.provideService(Scope.Scope, scope)));
  registryState.scope = scope;
  registryState.set = set;
  return set;
}

export function trackWork(effect: Effect.Effect<unknown>): void {
  const set = registryOf();
  Effect.runFork(FiberSet.run(set, Effect.ignore(effect)));
}

export function trackPending(task: Promise<unknown>): void {
  trackWork(Effect.promise(() => task.then(() => undefined, () => undefined)));
}

export function pendingCount(): number {
  const set = registryState.set;
  if (!set) return 0;
  return Effect.runSync(FiberSet.size(set));
}

export async function settleTasks(timeoutMs: number): Promise<boolean> {
  const set = registryState.set;
  const scope = registryState.scope;
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
    registryState.set = undefined;
    registryState.scope = undefined;
  }
  return drained;
}
