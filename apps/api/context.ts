import { Effect, Layer, ManagedRuntime } from "effect";
import { envFile } from "@opendum/platform/config";
import { ProxyContextLayer } from "@opendum/api/proxy/context";
import { LoggerLayer } from "@opendum/api/proxy/logger";
import { ProxyContextTag, type ProxyContext } from "@opendum/api/proxy/services";

type Runtime = ManagedRuntime.ManagedRuntime<Layer.Success<typeof ProxyContextLayer>, Layer.Error<typeof ProxyContextLayer>>;

const runtimeState: { current?: Runtime } = {};

function buildRuntime(): Runtime {
  envFile(".env");
  envFile("apps/api/.env");
  return ManagedRuntime.make(ProxyContextLayer.pipe(Layer.provideMerge(LoggerLayer)), {
    memoMap: Layer.makeMemoMapUnsafe(),
  });
}

export function proxyRuntime(): Runtime {
  runtimeState.current ??= buildRuntime();
  return runtimeState.current;
}

export function proxyContext(): Promise<ProxyContext> {
  return proxyRuntime().runPromise(
    Effect.gen(function* () {
      return yield* ProxyContextTag;
    })
  );
}

export async function disposeContext(): Promise<void> {
  const current = runtimeState.current;
  runtimeState.current = undefined;
  if (!current) return;
  await current.dispose();
}
