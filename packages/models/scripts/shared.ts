import { runFetchJson } from "../sync/http.ts";
import { asTrimmedString, stringAt } from "../json.ts";
import { dirname, fromFileUrl, join } from "../paths.ts";

const SCRIPT_DIR = dirname(fromFileUrl(import.meta.url));
const PACKAGE_DIR = join(SCRIPT_DIR, "..");

const UNPKG_ROOT = "https://unpkg.com";

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

export function packageModelsDir(): string {
  return join(PACKAGE_DIR, "data");
}

export function packageGeneratedDir(): string {
  return join(PACKAGE_DIR, "generated");
}

export function repoRoot(): string {
  return join(PACKAGE_DIR, "..", "..");
}

export function env(name: string): string | undefined {
  const value = Bun.env[name]?.trim();
  return value && value.length > 0 ? value : undefined;
}

export async function latestPackageVersion(packageName: string): Promise<string> {
  const manifest = await runFetchJson(`${UNPKG_ROOT}/${packageName}/package.json`, {
    label: `${packageName} package manifest`,
  });
  const version = asTrimmedString(stringAt(manifest, "version"));
  if (!version) {
    throw new Error(`Could not read the version of ${packageName} from unpkg`);
  }
  return version;
}

export async function fetchPackageFile(
  packageName: string,
  filePath: string,
  options: { version?: string; label?: string } = {}
): Promise<unknown> {
  const specifier = options.version ? `${packageName}@${options.version}` : packageName;
  const url = `${UNPKG_ROOT}/${specifier}/${filePath.replace(/^\/+/, "")}`;
  return runFetchJson(url, { label: options.label ?? `${specifier}/${filePath}` });
}

export async function fetchPackageJson(
  packageName: string,
  filePath: string,
  options: { label?: string } = {}
): Promise<{ version: string; payload: unknown }> {
  const version = await latestPackageVersion(packageName);
  const payload = await fetchPackageFile(packageName, filePath, {
    version,
    label: options.label,
  });
  return { version, payload };
}

export function runScript(body: () => Promise<void>): void {
  body().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
