import { Effect } from "effect";
import type { OpendumRedis } from "@opendum/core/redis";
import { proxyContext } from "../../context.js";
import { fromPromise } from "./task.js";

export const getRedisClient = Effect.fn("getRedisClient")(function* () {
  const context = yield* fromPromise(() => proxyContext(), "Failed to start the proxy runtime");
  return context.redis;
}) as () => Effect.Effect<OpendumRedis, import("../errors.js").ServiceFailure>;
