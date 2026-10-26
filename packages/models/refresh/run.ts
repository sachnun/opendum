import { Effect, Match, Option, Ref } from "effect";
import { buildIndex } from "@opendum/models/model-store";
import { writeText } from "@opendum/models/fs";
import { dataDir, flags, repoRoot } from "@opendum/models/refresh/core/env";
import { SOURCES } from "@opendum/models/refresh/providers/index";
import { runSources } from "@opendum/models/refresh/core/runner";
import type { SourceContext } from "@opendum/models/refresh/core/types";

type Snapshot = ReadonlyMap<string, ReadonlySet<string>>;

const snapshot = (modelsDir: string, providers: ReadonlyArray<string>): Snapshot => {
  const result = new Map<string, Set<string>>(providers.map((provider) => [provider, new Set<string>()]));
  for (const [modelId, entry] of Object.entries(buildIndex(modelsDir))) {
    const publicId = entry.id || modelId;
    for (const provider of entry.data.providers ?? []) {
      result.get(provider)?.add(publicId);
    }
  }
  return result;
};

const diff = (before: Snapshot, after: Snapshot): string => {
  const added: Array<string> = [];
  const removed: Array<string> = [];
  for (const provider of new Set([...before.keys(), ...after.keys()])) {
    const oldKeys = before.get(provider) ?? new Set<string>();
    const newKeys = after.get(provider) ?? new Set<string>();
    for (const key of newKeys) if (!oldKeys.has(key)) added.push(`+ ${key} (${provider})`);
    for (const key of oldKeys) if (!newKeys.has(key)) removed.push(`- ${key} (${provider})`);
  }
  const lines = [...added.sort(), ...removed.sort()];
  return Match.value(lines.length > 0).pipe(
    Match.when(true, () => `Models:\n${lines.join("\n")}\n`),
    Match.orElse(() => "")
  );
};

const writeSummary = (path: string, content: string): Effect.Effect<void> =>
  Effect.sync(() => {
    writeText(path, content);
    console.log(`PR summary written to ${path}`);
  });

const program = Effect.gen(function* () {
  const parsed = flags();
  const ctx: SourceContext = { modelsDir: dataDir(), repoRoot: repoRoot(), flags: parsed };
  const providers = SOURCES.map((source) => source.provider);
  const before = snapshot(ctx.modelsDir, providers);
  const exitCode = yield* Ref.make(0);

  const report = yield* runSources(SOURCES, ctx);

  yield* Effect.forEach(
    report.failures,
    (failure) =>
      Effect.andThen(Effect.logError(failure.message), Ref.set(exitCode, 1)),
    { discard: true }
  );

  const summary = diff(before, snapshot(ctx.modelsDir, providers));
  yield* Option.match(Option.fromNullishOr(parsed.summaryPath), {
    onNone: () => Effect.void,
    onSome: (path) => writeSummary(path, summary),
  });

  return yield* Ref.get(exitCode);
});

Effect.runPromise(
  program.pipe(
    Effect.tap((code) => Effect.sync(() => {
      if (code !== 0) process.exitCode = code;
    })),
    Effect.catchCause((cause) =>
      Effect.sync(() => {
        console.error(cause);
        process.exitCode = 1;
      })
    )
  )
);
