import { definePlugin } from "nitro";
import { Effect } from "effect";

export default definePlugin(() => {
  if (!process.env.DATABASE_URL || !process.env.REDIS_URL) return;

  Effect.runFork(
    Effect.gen(function* () {
      const startedAt = performance.now();
      const { registry } = yield* Effect.promise(() => import("@opendum/api/web/lib/proxy/models"));
      const { proxyContext } = yield* Effect.promise(() => import("@opendum/api/context"));
      yield* Effect.tryPromise({ try: () => proxyContext(), catch: (cause) => cause });
      yield* Effect.log(`[api] warmup ready with ${registry.allModels().length} models in ${Math.round(performance.now() - startedAt)}ms`);
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("[api] warmup failed").pipe(Effect.annotateLogs({ cause: String(cause) }))
      )
    )
  );
});
