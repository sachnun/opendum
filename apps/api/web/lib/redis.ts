import { Effect } from "effect";
import type { OpendumRedis } from "@opendum/core/redis";
import { proxyContext } from "@opendum/api/context";
import { fromPromise } from "@opendum/api/web/lib/task";
import type { ServiceFailure } from "@opendum/api/web/errors";

export const getRedisClient = Effect.fn("getRedisClient")(function* () {
  const context = yield* fromPromise(() => proxyContext(), "Failed to start the proxy runtime");
  return context.redis;
}) as () => Effect.Effect<OpendumRedis, ServiceFailure>;
