import { Effect, type Scope } from "effect";
import { createClient, type RedisClientType } from "redis";

export type OpendumRedis = RedisClientType;

export async function openRedis(redisUrl: string): Promise<OpendumRedis> {
  const client = createClient({ url: redisUrl });
  client.on("error", () => undefined);
  await client.connect();
  await client.ping();
  return client as OpendumRedis;
}

export async function closeRedis(client: OpendumRedis | null | undefined): Promise<void> {
  if (!client || !client.isOpen) return;
  await client.quit();
}

export function acquireRedis(redisUrl: string): Effect.Effect<OpendumRedis, Error, Scope.Scope> {
  return Effect.acquireRelease(
    Effect.tryPromise({
      try: () => openRedis(redisUrl),
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    }),
    (client) => Effect.promise(() => closeRedis(client))
  );
}
