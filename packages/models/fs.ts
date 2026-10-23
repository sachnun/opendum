import { mkdir as fsMkdir, rename as fsRename } from "node:fs/promises";

import { Effect } from "effect";

import { ModelParseFailure, ModelReadFailure, ModelWriteFailure, asError } from "./errors.ts";
import { dirname } from "./paths.ts";

const decoder = new TextDecoder();
const encoder = new TextEncoder();
const JSON_GLOB = "**/*.json";

const MISSING_MTIME = 4503599627370495;

function errorCode(cause: unknown): string | undefined {
  if (cause === null || typeof cause !== "object") return undefined;
  const code = (cause as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

export function isMissing(cause: unknown): boolean {
  return errorCode(cause) === "ENOENT";
}

function readFailure(path: string, cause: unknown): ModelReadFailure {
  return new ModelReadFailure({ message: asError(cause).message, path, cause });
}

function writeFailure(path: string, cause: unknown): ModelWriteFailure {
  return new ModelWriteFailure({ message: asError(cause).message, path, cause });
}

function missing(path: string, syscall: string): Error {
  return Object.assign(new Error(`ENOENT: no such file or directory, ${syscall} '${path}'`), {
    code: "ENOENT",
    path,
    syscall,
  });
}

export function fileSize(path: string): number {
  return Bun.file(path).size;
}

export function exists(path: string): boolean {
  try {
    return Bun.file(path).lastModified !== MISSING_MTIME;
  } catch {
    return false;
  }
}

export function isDirectory(path: string): boolean {
  try {
    Bun.mmap(path);
    return false;
  } catch (cause) {
    return errorCode(cause) === "EISDIR";
  }
}

export function isFile(path: string): boolean {
  if (!exists(path)) return false;
  return !isDirectory(path);
}

export function readBytes(path: string): Uint8Array {
  try {
    return Bun.mmap(path);
  } catch (cause) {
    const code = errorCode(cause);
    if (code === "EINVAL") return new Uint8Array();
    if (code === "ENOENT") throw missing(path, "open");
    if (code === "EISDIR") {
      throw Object.assign(new Error(`EISDIR: illegal operation on a directory, read '${path}'`), {
        code,
        path,
        syscall: "read",
      });
    }
    throw cause;
  }
}

export function readText(path: string): string {
  return decoder.decode(readBytes(path));
}

export function readJson(path: string): unknown {
  const content = readText(path);
  if (content.length === 0) {
    throw new SyntaxError(`Unexpected end of JSON input: ${path}`);
  }
  return JSON.parse(content);
}

export function tryReadText(path: string): Effect.Effect<string, ModelReadFailure> {
  return Effect.try({
    try: () => readText(path),
    catch: (cause) => readFailure(path, cause),
  });
}

export function tryReadBytes(path: string): Effect.Effect<Uint8Array, ModelReadFailure> {
  return Effect.try({
    try: () => readBytes(path),
    catch: (cause) => readFailure(path, cause),
  });
}

export function tryReadJson(
  path: string
): Effect.Effect<unknown, ModelReadFailure | ModelParseFailure> {
  return Effect.try({
    try: () => readJson(path),
    catch: (cause) =>
      cause instanceof SyntaxError
        ? new ModelParseFailure({ message: `invalid model JSON: ${path}`, path, cause })
        : readFailure(path, cause),
  });
}

export function tryWriteBytes(
  path: string,
  content: Uint8Array
): Effect.Effect<void, ModelWriteFailure> {
  return Effect.tryPromise({
    try: () => Bun.write(path, content).then(() => undefined),
    catch: (cause) => writeFailure(path, cause),
  });
}

export function tryWriteText(path: string, content: string): Effect.Effect<void, ModelWriteFailure> {
  return tryWriteBytes(path, encoder.encode(content));
}

export function tryRemove(path: string): Effect.Effect<void, ModelWriteFailure> {
  return Effect.tryPromise({
    try: async () => {
      if (!exists(path) || isDirectory(path)) return;
      try {
        await Bun.file(path).delete();
      } catch (cause) {
        if (isMissing(cause)) return;
        throw cause;
      }
    },
    catch: (cause) => writeFailure(path, cause),
  });
}

export function tryRename(
  from: string,
  to: string
): Effect.Effect<void, ModelReadFailure | ModelWriteFailure> {
  return Effect.tryPromise({
    try: async () => {
      if (from === to) return;
      await fsMkdir(dirname(to), { recursive: true });
      await fsRename(from, to);
    },
    catch: (cause) =>
      isMissing(cause) ? readFailure(from, cause) : writeFailure(from, cause),
  });
}

export function writeBytes(path: string, content: Uint8Array): Promise<void> {
  return Effect.runPromise(tryWriteBytes(path, content));
}

export function writeText(path: string, content: string): Promise<void> {
  return Effect.runPromise(tryWriteText(path, content));
}

export function remove(path: string): Promise<void> {
  return Effect.runPromise(tryRemove(path));
}

export function rename(from: string, to: string): Promise<void> {
  return Effect.runPromise(tryRename(from, to));
}

function listWith(scan: () => Iterable<string>): string[] {
  const files: string[] = [];
  try {
    for (const relativePath of scan()) files.push(relativePath);
  } catch (cause) {
    const code = errorCode(cause);
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw cause;
  }
  return files.sort();
}

export function listFiles(root: string, pattern = "*", options: { dot?: boolean } = {}): string[] {
  return listWith(() => new Bun.Glob(pattern).scanSync({ cwd: root, dot: options.dot ?? true }));
}

export function listJsonFiles(root: string): string[] {
  return listFiles(root, JSON_GLOB);
}

export function tryListJsonFiles(root: string): Effect.Effect<string[], ModelReadFailure> {
  return Effect.try({
    try: () => listJsonFiles(root),
    catch: (cause) => readFailure(root, cause),
  });
}

export function sha256Hex(value: string | Uint8Array): string {
  return Bun.SHA256.hash(toBuffer(value), "hex");
}

export function sha256Bytes(value: string | Uint8Array): Uint8Array {
  const digest = Bun.SHA256.hash(toBuffer(value));
  return new Uint8Array(digest.buffer, digest.byteOffset, digest.byteLength);
}

function toBuffer(value: string | Uint8Array): Uint8Array<ArrayBuffer> {
  if (typeof value === "string") return encoder.encode(value);
  return new Uint8Array(value.buffer as ArrayBuffer, value.byteOffset, value.byteLength);
}

export function gzip(payload: Uint8Array): Uint8Array {
  return Bun.gzipSync(toBuffer(payload));
}

export function gunzip(payload: Uint8Array): Uint8Array {
  return Bun.gunzipSync(toBuffer(payload));
}

export function fromHex(value: string): Uint8Array {
  return Uint8Array.fromHex(value);
}

export function encodeText(value: string): Uint8Array {
  return encoder.encode(value);
}

export function decodeText(value: Uint8Array): string {
  return decoder.decode(value);
}

export async function aesGcmDecrypt(
  key: Uint8Array,
  iv: Uint8Array,
  payload: Uint8Array
): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    toBuffer(key),
    "AES-GCM",
    false,
    ["decrypt"]
  );
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toBuffer(iv), tagLength: 128 },
    cryptoKey,
    toBuffer(payload)
  );
  return new Uint8Array(plain);
}
