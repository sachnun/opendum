import { describe, expect, it } from "bun:test";
import { ConfigProvider, Effect, Exit, Schedule } from "effect";
import { TestClock } from "effect/testing";
import { proxyConfig } from "../config.js";
import {
  AuthenticationFailure,
  RateLimitFailure,
  ValidationFailure,
  fromRouteError,
  routeErrorResponse,
  toRouteError,
  type ProxyFailure,
} from "../core/errors.js";

const env = {
  DATABASE_URL: "postgres://localhost/db",
  REDIS_URL: "redis://localhost:6379",
  BETTER_AUTH_SECRET: "secret",
};

describe("proxy config", () => {
  it("reads required values from the environment", async () => {
    const provider = ConfigProvider.fromEnv({ env });
    const config = await Effect.runPromise(proxyConfig.parse(provider));
    expect(config.databaseUrl).toBe(env.DATABASE_URL);
    expect(config.redisUrl).toBe(env.REDIS_URL);
    expect(config.betterAuthSecret).toBe(env.BETTER_AUTH_SECRET);
    expect(config.requestTimeoutMs).toBe(90 * 1000);
  });

  it("disables the token refresh loop outside production", async () => {
    const provider = ConfigProvider.fromEnv({ env: { ...env, NODE_ENV: "development" } });
    const config = await Effect.runPromise(proxyConfig.parse(provider));
    expect(config.tokenRefreshIntervalMs).toBe(0);
  });

  it("enables the token refresh loop in production", async () => {
    const provider = ConfigProvider.fromEnv({ env: { ...env, NODE_ENV: "production" } });
    const config = await Effect.runPromise(proxyConfig.parse(provider));
    expect(config.tokenRefreshIntervalMs).toBe(600 * 1000);
  });

  it("fails when a required value is missing", async () => {
    const provider = ConfigProvider.fromEnv({ env: { REDIS_URL: "redis://x", BETTER_AUTH_SECRET: "s" } });
    const exit = await Effect.runPromiseExit(proxyConfig.parse(provider));
    expect(Exit.isFailure(exit)).toBe(true);
  });
});

describe("typed proxy errors", () => {
  it("round trips a route error through the typed representation", () => {
    const routeError = {
      status: 429,
      message: "slow down",
      type: "rate_limit_error",
      retryAfter: "3s",
      retryAfterMs: 3000,
    };
    const failure = fromRouteError(routeError);
    expect(failure._tag).toBe("RateLimitFailure");
    expect(toRouteError(failure)).toMatchObject(routeError);
  });

  it("maps an authentication failure to a 401 envelope", () => {
    const failure = new AuthenticationFailure({ message: "Invalid API key" });
    const response = routeErrorResponse(toRouteError(failure), "openai");
    expect(response.status).toBe(401);
  });

  it("formats anthropic errors with the anthropic envelope", async () => {
    const failure = new ValidationFailure({ message: "bad model", param: "model", code: "invalid_model" });
    const response = routeErrorResponse(toRouteError(failure), "anthropic");
    expect(response.status).toBe(400);
    const body = (await response.json()) as { type: string; error: { type: string; message: string } };
    expect(body.type).toBe("error");
    expect(body.error.message).toBe("bad model");
  });

  it("sets a Retry-After header for rate limits", () => {
    const failure = new RateLimitFailure({
      message: "limited",
      status: 429,
      retryAfter: "2s",
      retryAfterMs: 2000,
    });
    const response = routeErrorResponse(toRouteError(failure), "openai");
    expect(response.headers.get("Retry-After")).toBe("2");
  });

  it("narrows tagged failures with catchTag", async () => {
    const failure: ProxyFailure = new AuthenticationFailure({ message: "nope" });
    const result = await Effect.runPromise(
      Effect.fail(failure).pipe(
        Effect.catchTag("AuthenticationFailure", (error) => Effect.succeed(error.message))
      )
    );
    expect(result).toBe("nope");
  });
});

describe("effect schedules", () => {
  it("retries transient failures with a bounded schedule", async () => {
    let attempts = 0;
    const flaky = Effect.suspend(() => {
      attempts += 1;
      return attempts < 3 ? Effect.fail(`transient-${attempts}`) : Effect.succeed(attempts);
    });
    const result = await Effect.runPromise(
      flaky.pipe(
        Effect.retry(
          Schedule.exponential("1 millis").pipe(
            Schedule.upTo({ times: 5 }),
            Schedule.jittered
          )
        )
      )
    );
    expect(result).toBe(3);
    expect(attempts).toBe(3);
  });

  it("stops retrying after the schedule is exhausted", async () => {
    let attempts = 0;
    const always = Effect.suspend(() => {
      attempts += 1;
      return Effect.fail("nope");
    });
    const exit = await Effect.runPromiseExit(always.pipe(Effect.retry(Schedule.recurs(2))));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(attempts).toBe(3);
  });

  it("uses TestClock to advance a spaced schedule without real time", async () => {
    const program = Effect.gen(function* () {
      let runs = 0;
      const poll = Effect.sync(() => {
        runs += 1;
        return runs;
      });
      const fiber = yield* Effect.forkChild(
        poll.pipe(Effect.repeat(Schedule.spaced("1 hour")), Effect.timeout("3 hours"))
      );
      yield* TestClock.adjust("3 hours");
      const exit = yield* Effect.promise(() => Promise.resolve(fiber));
      void exit;
      return runs;
    });
    const runs = await Effect.runPromise(Effect.provide(program, TestClock.layer()));
    expect(runs).toBeGreaterThanOrEqual(2);
  });
});
