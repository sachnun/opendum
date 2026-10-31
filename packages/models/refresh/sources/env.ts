import { dirname, fileUrl, join } from "@opendum/models/paths";

const CORE_DIR = dirname(fileUrl(import.meta.url));
const PACKAGE_DIR = join(CORE_DIR, "..", "..");

export type ScriptFlags = {
  dryRun: boolean;
  verbose: boolean;
  summaryPath: string | null;
};

export function flags(argv: readonly string[] = Bun.argv): ScriptFlags {
  return {
    dryRun: argv.includes("--dry-run"),
    verbose: argv.includes("--verbose") || argv.includes("-v"),
    summaryPath: valueAfter(argv, "--summary"),
  };
}

function valueAfter(argv: readonly string[], flag: string): string | null {
  const index = argv.indexOf(flag);
  if (index < 0) return null;
  const value = argv[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

export function dataDir(): string {
  return join(PACKAGE_DIR, "data");
}

export function repoRoot(): string {
  return join(PACKAGE_DIR, "..", "..");
}

export function env(name: string): string | undefined {
  const value = Bun.env[name]?.trim();
  return value && value.length > 0 ? value : undefined;
}

export function runScript(body: () => Promise<void>): void {
  body().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
