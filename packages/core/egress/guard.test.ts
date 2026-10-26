import { describe, expect, it } from "bun:test";
import { Effect, Exit } from "effect";
import { guardedFetch } from "@opendum/core/egress/guard";

function messageOf(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as { cause?: unknown }).cause;
  return cause instanceof Error ? `${error.message} ${cause.message}` : error.message;
}

function failureText(exit: Exit.Exit<unknown, unknown>): string {
  if (Exit.isSuccess(exit)) return "";
  const failure = Exit.isFailure(exit) ? exit.cause : undefined;
  return failure ? String(failure) : "";
}

describe("guardedFetch", () => {
  it("rejects literal loopback addresses before connecting", async () => {
    const guard = guardedFetch({ connectTimeout: 1000 });
    const exit = await Effect.runPromiseExit(
      Effect.tryPromise({
        try: () => guard.fetch("http://127.0.0.1:8080/"),
        catch: (cause) => cause,
      })
    );
    await guard.close();
    expect(Exit.isFailure(exit)).toBe(true);
    expect(/private/u.test(failureText(exit)) || /private/u.test(messageOf(exit))).toBe(true);
  });
});
