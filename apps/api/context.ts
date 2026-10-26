import { Effect, Layer, ManagedRuntime } from "effect";
import { envFile } from "@opendum/core/config";
import { ProxyContextLayer } from "./core/context.js";
import { LoggerLayer } from "./core/logger.js";
import { ProxyContextTag, type ProxyContext } from "./core/services.js";

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
