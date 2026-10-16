import { describe, expect, it } from "bun:test";
import { Effect, Exit } from "effect";

import {
  ModelParseFailure,
  ModelReadFailure,
  ModelsDirectoryFailure,
  asError,
  modelFailureMessage,
} from "./errors.ts";
import { tryLoadModelEntries } from "./registry.ts";
import { tryRead } from "./model-store.ts";

function failureOf<E>(exit: Exit.Exit<unknown, E>): E {
  const option = Exit.findErrorOption(exit);
  if (option._tag === "None") throw new Error("expected a failure");
  return option.value;
}

describe("models typed errors", () => {
  it("reports a missing models directory as a typed failure", async () => {
    const exit = await Effect.runPromiseExit(tryLoadModelEntries("/definitely/not/here"));
    expect(Exit.isFailure(exit)).toBe(true);
    const error = failureOf(exit);
    expect(error).toBeInstanceOf(ModelsDirectoryFailure);
    expect(error._tag).toBe("ModelsDirectoryFailure");
  });

  it("reports invalid model JSON as a typed parse failure", async () => {
    const exit = await Effect.runPromiseExit(tryRead("{ not json", "bad.json"));
    expect(Exit.isFailure(exit)).toBe(true);
    const error = failureOf(exit);
    expect(error).toBeInstanceOf(ModelParseFailure);
    expect(error.path).toBe("bad.json");
  });

  it("parses valid model JSON on the success channel", async () => {
    const data = await Effect.runPromise(tryRead('{"id":"gpt-5"}'));
    expect(data.id).toBe("gpt-5");
  });

  it("maps unknown causes to an Error", () => {
    expect(modelFailureMessage(new Error("boom"))).toBe("boom");
    expect(modelFailureMessage("plain")).toBe("plain");
    expect(asError("plain").message).toBe("plain");
    expect(asError(new ModelReadFailure({ message: "x", path: "p" }))).toBeInstanceOf(Error);
  });
});
