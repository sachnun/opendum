import { Effect } from "effect";
import type { OpendumRedis } from "@opendum/core/redis";
import { getProxyContext } from "../../context.js";
import { fromPromise } from "./task.js";

export const getRedisClient = Effect.fn("getRedisClient")(function* () {
  const context = yield* fromPromise(() => getProxyContext(), "Failed to start the proxy runtime");
  return context.redis;
}) as () => Effect.Effect<OpendumRedis, import("../errors.js").ServiceFailure>;
