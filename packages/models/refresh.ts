import { Effect, Exit, Ref,Schema } from "effect";


import type { ModelFetchFailure, ModelParseFailure, ModelTimeoutFailure } from "@opendum/models/errors";
import { compareText } from "@opendum/models/compare";

export class ScraperFailure extends Schema.TaggedError<ScraperFailure>()("ScraperFailure", {
  message: Schema.String,
  script: Schema.String,
  exitCode: Schema.Number,
}) {}

export type RefreshFailure = ScraperFailure | ModelFetchFailure | ModelTimeoutFailure | ModelParseFailure;

export interface RefreshStep {

  script: string;

  path: string;
}

export interface RefreshResult {
  ran: string[];
  failed: ScraperFailure[];
}

export function runSteps(
  steps: ReadonlyArray<RefreshStep>,
  spawn: (step: RefreshStep) => Promise<number>
): Effect.Effect<RefreshResult> {
  return Effect.gen(function* () {
    const ran = yield* Ref.make<string[]>([]);
    const failed = yield* Ref.make<ScraperFailure[]>([]);

    for (const step of steps) {
      const exitCode = yield* Effect.tryPromise({
        try: () => spawn(step),
        catch: (cause) =>
          new ScraperFailure({
            message: cause instanceof Error ? cause.message : String(cause),
            script: step.script,
            exitCode: 1,
          }),
      }).pipe(Effect.exit);

      if (Exit.isSuccess(exitCode) && exitCode.value === 0) {
        yield* Ref.update(ran, (current) => [...current, step.script]);
        continue;
      }

      const failure =
        Exit.isFailure(exitCode)
          ? (Exit.findErrorOption(exitCode) as { _tag: "Some"; value: ScraperFailure }).value
          : new ScraperFailure({
              message: `${step.script} exited with code ${exitCode.value}`,
              script: step.script,
              exitCode: exitCode.value,
            });

      yield* Ref.update(failed, (current) => [...current, failure]);
      yield* Effect.logWarning(`[models] ${failure.message}`);
    }

    return {
      ran: yield* Ref.get(ran),
      failed: yield* Ref.get(failed),
    };
  });
}

export function spawnScript(path: string): Promise<number> {
  const child = Bun.spawn({
    cmd: [process.execPath, path],
    stdout: "inherit",
    stderr: "inherit",
  });
  return child.exited;
}

export function orderScripts(
  names: ReadonlyArray<string>,
  tail: ReadonlyArray<string>
): string[] {
  return [...names].sort((left, right) => {
    const rank = Number(tail.includes(left)) - Number(tail.includes(right));
    return rank !== 0 ? rank : compareText(left, right);
  });
}
