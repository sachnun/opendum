import { Context, Effect, Layer } from "effect";
import type Redis from "ioredis";
import { getRedisClient } from "@/lib/redis";
import { db as database } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { RedisError, UnauthorizedError, DatabaseError } from "./errors";

// ---------------------------------------------------------------------------
// Redis
// ---------------------------------------------------------------------------

export class RedisService extends Context.Tag("RedisService")<
  RedisService,
  Redis
>() {}

export const RedisLive = Layer.effect(
  RedisService,
  Effect.tryPromise({
    try: () => getRedisClient(),
    catch: (cause) => new RedisError({ cause }),
  })
);

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

type Database = typeof database;

export class DatabaseService extends Context.Tag("DatabaseService")<
  DatabaseService,
  Database
>() {}

export const DatabaseLive = Layer.succeed(DatabaseService, database);

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export interface AuthSession {
  user: {
    id: string;
    name?: string | null;
    email?: string | null;
    image?: string | null;
  };
}

export class SessionService extends Context.Tag("SessionService")<
  SessionService,
  AuthSession
>() {}

export const SessionLive = Layer.effect(
  SessionService,
  Effect.gen(function* () {
    const session = yield* Effect.tryPromise({
      try: () => getSession(),
      catch: (cause) => new DatabaseError({ cause }),
    });

    if (!session?.user?.id) {
      return yield* new UnauthorizedError({ message: "Unauthorized" });
    }

    return session as AuthSession;
  })
);

// ---------------------------------------------------------------------------
// Convenience: require authenticated userId from session
// ---------------------------------------------------------------------------

export const requireUserId: Effect.Effect<string, UnauthorizedError | DatabaseError, SessionService> =
  Effect.gen(function* () {
    const session = yield* SessionService;
    return session.user.id;
  });
