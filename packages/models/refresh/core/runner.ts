import { Effect, Exit, Option } from "effect";
import { syncCli } from "@opendum/models/refresh/steps/version-sync";
import { buildIndex } from "@opendum/models/model-store";
import { apply, report } from "@opendum/models/refresh/core/keys";
import { causeMessage } from "@opendum/models/refresh/core/failure";
import type {
  ModelSource,
  RunReport,
  SourceContext,
  SourceFailure,
  SourceOutcome,
  SourceResult,
  VersionTarget,
} from "@opendum/models/refresh/core/types";
import { compareText } from "@opendum/models/compare";

type Snapshot = ReadonlyMap<string, ReadonlySet<string>>;

const phaseRank = (source: ModelSource): number => (source.phase === "tail" ? 1 : 0);

const orderSources = (sources: ReadonlyArray<ModelSource>): ReadonlyArray<ModelSource> =>
  [...sources].sort(
    (left, right) =>
      phaseRank(left) - phaseRank(right) ||
      left.order - right.order ||
      compareText(left.provider, right.provider)
  );

const snapshot = (modelsDir: string, providers: ReadonlyArray<string>): Snapshot => {
  const index = buildIndex(modelsDir);
  const result = new Map<string, Set<string>>(providers.map((provider) => [provider, new Set<string>()]));
  for (const [modelId, entry] of Object.entries(index)) {
    const publicId = entry.id || modelId;
    for (const provider of entry.data.providers ?? []) {
      result.get(provider)?.add(publicId);
    }
  }
  return result;
};

const failed = (provider: string, message: string): SourceFailure => ({ provider, message });

const versionSync = (
  source: ModelSource,
  ctx: SourceContext,
  targets: ReadonlyArray<VersionTarget>
): Effect.Effect<void> => {
  if (ctx.flags.dryRun || targets.length === 0) return Effect.void;
  return Option.match(Option.fromNullishOr(source.latestVersion), {
    onNone: () => Effect.void,
    onSome: (latest) =>
      latest().pipe(
        Effect.flatMap((version) => Effect.promise(() => syncCli(source.label, [...targets], version))),
        Effect.catchCause((cause) =>
          Effect.logWarning(`[${source.label}] version sync failed (${causeMessage(cause)})`)
        )
      ),
  });
};

const runSource = (source: ModelSource, ctx: SourceContext): Effect.Effect<SourceOutcome, SourceFailure> =>
  Effect.gen(function* () {
    const result: SourceResult = yield* source.fetch(ctx);
    if (result.models.size === 0) {
      return {
        provider: source.provider,
        label: source.label,
        synced: { added: [], removed: [], updated: [] },
        notes: [`[${source.label}] no models returned; skipped`],
      };
    }

    const synced = yield* apply(ctx, source.provider, result);
    const notes: string[] = [report(source.label, synced, result.models.size)];

    if (source.enrich) {
      notes.push(...(yield* source.enrich(ctx, result, synced)));
    }

    yield* versionSync(source, ctx, source.versionTargets?.(ctx) ?? []);

    return { provider: source.provider, label: source.label, synced, notes };
  });

const vanished = (before: Snapshot, after: Snapshot): ReadonlyArray<SourceFailure> =>
  [...before.entries()].flatMap(([provider, oldKeys]) => {
    const newKeys = after.get(provider) ?? new Set<string>();
    return oldKeys.size > 0 && newKeys.size === 0
      ? [failed(provider, `[${provider}] all models disappeared from the registry`)]
      : [];
  });

export const runSources = (
  sources: ReadonlyArray<ModelSource>,
  ctx: SourceContext
): Effect.Effect<RunReport> =>
  Effect.gen(function* () {
    const providers = sources.map((source) => source.provider);
    const before = snapshot(ctx.modelsDir, providers);

    const acc = yield* Effect.reduce(
      orderSources(sources),
      () => ({ outcomes: [] as SourceOutcome[], failures: [] as SourceFailure[] }),
      (state, source) =>
        runSource(source, ctx).pipe(
          Effect.tap((outcome) =>
            Effect.forEach(outcome.notes, (note) => Effect.logInfo(note), { discard: true })
          ),
          Effect.exit,
          Effect.flatMap((exit) =>
            Exit.isSuccess(exit)
              ? Effect.succeed({ ...state, outcomes: [...state.outcomes, exit.value] })
              : Effect.logError(causeMessage(exit.cause)).pipe(
                  Effect.as({
                    ...state,
                    failures: [...state.failures, failed(source.provider, causeMessage(exit.cause))],
                  })
                )
          )
        )
    );

    const after = snapshot(ctx.modelsDir, providers);
    return { outcomes: acc.outcomes, failures: [...acc.failures, ...vanished(before, after)] };
  });
