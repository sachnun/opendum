import { Effect, Layer, ManagedRuntime } from "effect";
import { envFile } from "@opendum/core/config";
import { ProxyContextLayer } from "@opendum/api/core/context";
import { LoggerLayer } from "@opendum/api/core/logger";
import { ProxyContextTag, type ProxyContext } from "@opendum/api/core/services";

type Runtime = ManagedRuntime.ManagedRuntime<Layer.Success<typeof ProxyContextLayer>, Layer.Error<typeof ProxyContextLayer>>;

let runtime: Runtime | undefined;

function buildRuntime(): Runtime {
  envFile(".env");
  envFile("apps/api/.env");
  return ManagedRuntime.make(ProxyContextLayer.pipe(Layer.provideMerge(LoggerLayer)), {
    memoMap: Layer.makeMemoMapUnsafe(),
  });
}

export function proxyRuntime(): Runtime {
  runtime ??= buildRuntime();
  return runtime;
}

export function proxyContext(): Promise<ProxyContext> {
  return proxyRuntime().runPromise(
    Effect.gen(function* () {
      return yield* ProxyContextTag;
    })
  );
}

export async function disposeContext(): Promise<void> {
  const current = runtime;
  runtime = undefined;
  if (!current) return;
  await current.dispose();
}
