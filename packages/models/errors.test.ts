import { describe, expect, it } from "bun:test";
import { Effect, Exit } from "effect";
import { raise } from "@opendum/models/refresh/sources/raise";

import {
  ModelParseFailure,
  ModelReadFailure,
  ModelsDirectoryFailure,
  asError,
  failureMessage,
} from "@opendum/models/errors";
import { tryLoad } from "@opendum/models/registry";
import { tryRead } from "@opendum/models/model-store";

function failureOf<E>(exit: Exit.Exit<unknown, E>): E {
  const option = Exit.findErrorOption(exit);
  if (option._tag === "None") raise(new Error("expected a failure"));
  return option.value;
}

describe("models typed errors", () => {
  it("reports a missing models directory as a typed failure", async () => {
    const exit = await Effect.runPromiseExit(tryLoad("/definitely/not/here"));
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
    expect(failureMessage(new Error("boom"))).toBe("boom");
    expect(failureMessage("plain")).toBe("plain");
    expect(asError("plain").message).toBe("plain");
    expect(asError(new ModelReadFailure({ message: "x", path: "p" }))).toBeInstanceOf(Error);
  });
});
