import { describe, expect, it } from "bun:test";
import { Effect, Exit } from "effect";

import { ServiceFailure, asServiceFailure, badRequest, forbidden, internal, notFound, unauthorized, unavailable } from "#web/errors.js";
import { fromPromise, fromSync, toActionResult, toVoidActionResult, withContext } from "#web/lib/task.js";

describe("web errors", () => {
  it("maps status codes to tagged failures", () => {
    expect(badRequest("bad").status).toBe(400);
    expect(unauthorized().status).toBe(401);
    expect(forbidden().status).toBe(403);
    expect(notFound("missing").status).toBe(404);
    expect(internal("boom").status).toBe(500);
    expect(unavailable("down").status).toBe(503);
  });

  it("keeps the original message and cause", () => {
    const cause = new Error("root");
    const failure = internal("wrapped", cause);
    expect(failure.message).toBe("wrapped");
    expect(failure.cause).toBe(cause);
  });

  it("passes tagged failures through asServiceFailure", () => {
    const failure = notFound("missing");
    expect(asServiceFailure(failure)).toBe(failure);
  });

  it("wraps unknown causes as internal failures", () => {
    const failure = asServiceFailure(new Error("raw"));
    expect(failure._tag).toBe("ServiceFailure");
    expect(failure.status).toBe(500);
    expect(failure.message).toBe("raw");
  });

  it("falls back to the provided message for non error causes", () => {
    expect(asServiceFailure("nope", "Request failed").message).toBe("nope");
    expect(asServiceFailure(undefined, "Request failed").message).toBe("Request failed");
  });
});

describe("web task helpers", () => {
  it("lifts a resolved promise", async () => {
    const value = await Effect.runPromise(fromPromise(async () => 42));
    expect(value).toBe(42);
  });

  it("maps a rejected promise to a ServiceFailure", async () => {
    const failure = await Effect.runPromise(
      fromPromise(async () => Promise.reject(new Error("boom")), "Failed").pipe(Effect.flip)
    );
    expect(failure).toBeInstanceOf(ServiceFailure);
    expect(failure.message).toBe("boom");
  });

  it("maps a thrown sync function to a ServiceFailure", async () => {
    const exit = await Effect.runPromiseExit(
      fromSync(() => {
        throw new Error("sync boom");
      })
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("rewrites the message with withContext", async () => {
    const failure = await Effect.runPromise(
      withContext(Effect.fail(badRequest("old")), "new").pipe(Effect.flip)
    );
    expect(failure.message).toBe("new");
  });

  it("turns a success into an ActionResult", async () => {
    const result = await Effect.runPromise(toActionResult(Effect.succeed("data")));
    expect(result).toEqual({ success: true, data: "data" });
  });

  it("turns a failure into a failed ActionResult", async () => {
    const result = await Effect.runPromise(toActionResult(Effect.fail(badRequest("nope"))));
    expect(result).toEqual({ success: false, error: "nope" });
  });

  it("turns void effects into data undefined", async () => {
    const result = await Effect.runPromise(toVoidActionResult(Effect.void));
    expect(result).toEqual({ success: true, data: undefined });
  });
});
