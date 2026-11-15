import type { Effect } from "effect";

export type SourcePhase = "fetch" | "tail";

export type SourceFlags = {
  readonly dryRun: boolean;
  readonly verbose: boolean;
  readonly summaryPath: string | null;
};

export type SourceContext = {
  readonly modelsDir: string;
  readonly repoRoot: string;
  readonly flags: SourceFlags;
};

export type SyncOutcome = {
  readonly added: ReadonlyArray<string>;
  readonly removed: ReadonlyArray<string>;
  readonly updated: ReadonlyArray<string>;
};

export type SourceResult = {
  readonly models: ReadonlyMap<string, string>;
  readonly providerConfig?: ReadonlyMap<string, Record<string, unknown>>;
  readonly managedKeys?: ReadonlyArray<string>;
  readonly extra?: ReadonlyMap<string, unknown>;
};

export type SourceFailure = {
  readonly provider: string;
  readonly message: string;
};

export type SourceOutcome = {
  readonly provider: string;
  readonly label: string;
  readonly synced: SyncOutcome;
  readonly notes: ReadonlyArray<string>;
};

export type RunReport = {
  readonly outcomes: ReadonlyArray<SourceOutcome>;
  readonly failures: ReadonlyArray<SourceFailure>;
};

export type VersionTarget = {
  readonly label: string;
  readonly path: string;
  readonly pattern: RegExp;
};

export type ModelSource = {
  readonly provider: string;
  readonly label: string;
  readonly order: number;
  readonly phase: SourcePhase;
  readonly fetch: (ctx: SourceContext) => Effect.Effect<SourceResult, SourceFailure>;
  readonly enrich?: (
    ctx: SourceContext,
    result: SourceResult,
    outcome: SyncOutcome
  ) => Effect.Effect<ReadonlyArray<string>>;
  readonly versionTargets?: (ctx: SourceContext) => ReadonlyArray<VersionTarget>;
  readonly latestVersion?: () => Effect.Effect<string | null>;
};

export const EMPTY_OUTCOME: SyncOutcome = { added: [], removed: [], updated: [] };

export const sourceOf = (models: ReadonlyMap<string, string>): SourceResult => ({ models });
