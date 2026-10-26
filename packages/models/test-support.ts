import { mkdirSync, rmSync } from "node:fs";

import { Effect } from "effect";

import { listJson, readText, remove, writeText } from "@opendum/models/fs";
import { join } from "@opendum/models/paths";

export function tmpRoot(): string {
  return Bun.env["TMPDIR"] ?? Bun.env["TMP"] ?? Bun.env["TEMP"] ?? "/tmp";
}

let counter = 0;

export function makeDir(prefix = "opendum-models-"): string {
  counter += 1;
  const dir = join(tmpRoot(), `${prefix}${process.pid}-${counter}-${Date.now().toString(36)}`);

  mkdirSync(dir, { recursive: true });
  return dir;
}

export async function inTemp<A>(run: (dir: string) => A | Promise<A>): Promise<A> {
  const dir = makeDir();
  try {
    return await run(dir);
  } finally {
    removeDir(dir);
  }
}

export function removeDir(dir: string): void {

  rmSync(dir, { recursive: true, force: true });
}

export function read(path: string): string {
  return readText(path);
}

export function write(path: string, content: string): Promise<void> {
  return writeText(path, content);
}

export function json<T>(path: string): T {
  return JSON.parse(readText(path)) as T;
}

export function jsonFiles(dir: string): string[] {
  return listJson(dir);
}

export function removeFile(path: string): Promise<void> {
  return remove(path);
}

export function runEffect<A, E>(effect: Effect.Effect<A, E>, label: string): Promise<A> {
  return Effect.runPromise(effect).catch((cause: unknown) => {
    throw new Error(`${label} failed: ${cause instanceof Error ? cause.message : String(cause)}`);
  });
}
