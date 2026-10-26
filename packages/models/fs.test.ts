import { describe, expect, test } from "bun:test";

import {
  decryptAes,
  decodeText,
  encodeText,
  exists,
  fileSize,
  fromHex,
  gzip,
  gunzip,
  isDirectory,
  isFile,
  listFiles,
  listJson,
  readBytes,
  readJson,
  readText,
  remove,
  rename,
  sha256Hex,
  loadJson,
  loadText,
  saveText,
  writeBytes,
  writeText,
} from "@opendum/models/fs";
import { join } from "@opendum/models/paths";
import { makeDir, removeDir } from "@opendum/models/test-support";
import { Effect, Exit } from "effect";
function withDir(name: string, body: (root: string) => Promise<void>): Promise<void> {
  const root = makeDir(name);
  return Effect.runPromise(
    Effect.tryPromise({
      try: () => body(root),
      catch: (cause) => cause,
    }).pipe(Effect.ensuring(Effect.sync(() => removeDir(root))))
  );
}


describe("bun fs primitives", () => {
  test("distinguishes files, directories, and missing paths", async () => {
    await withDir("fs-", async (root) => {
        await writeText(join(root, "nested", "a.json"), '{"a":1}');
        expect(exists(root)).toBe(true);
        expect(isDirectory(root)).toBe(true);
        expect(isDirectory(join(root, "nested", "a.json"))).toBe(false);
        expect(isFile(join(root, "nested", "a.json"))).toBe(true);
        expect(exists(join(root, "absent.json"))).toBe(false);
        expect(isFile(join(root, "absent.json"))).toBe(false);
    });
  });

  test("reads text, bytes, and JSON", async () => {
    await withDir("fs-", async (root) => {
        await writeText(join(root, "a.json"), '{"a":1}');
        await writeText(join(root, "empty.txt"), "");
        expect(readText(join(root, "a.json"))).toBe('{"a":1}');
        expect(readText(join(root, "empty.txt"))).toBe("");
        expect(readJson(join(root, "a.json"))).toEqual({ a: 1 });
        expect(decodeText(readBytes(join(root, "a.json")))).toBe('{"a":1}');
        expect(fileSize(join(root, "a.json"))).toBe(7);
    });
  });

  test("reports a missing file as ENOENT and a directory as EISDIR", async () => {
    await withDir("fs-", async (root) => {
        expect(() => readText(join(root, "absent.json"))).toThrow(/ENOENT/);
        expect(() => readText(root)).toThrow(/EISDIR/);
    });
  });

  test("reports invalid JSON as a SyntaxError", async () => {
    await withDir("fs-", async (root) => {
        await writeText(join(root, "bad.json"), "{ oops");
        expect(() => readJson(join(root, "bad.json"))).toThrow(SyntaxError);
        await writeText(join(root, "empty.json"), "");
        expect(() => readJson(join(root, "empty.json"))).toThrow(/Unexpected end of JSON input/);
    });
  });

  test("writes create parent directories and truncate the target", async () => {
    await withDir("fs-", async (root) => {
        await writeText(join(root, "deep", "nested", "a.json"), '{"a":1}');
        expect(readText(join(root, "deep", "nested", "a.json"))).toBe('{"a":1}');

        await writeText(join(root, "deep", "nested", "a.json"), "short");
        expect(readText(join(root, "deep", "nested", "a.json"))).toBe("short");

        const large = JSON.stringify({ pad: "x".repeat(300_000) });
        await writeText(join(root, "deep", "large.json"), large);
        expect(fileSize(join(root, "deep", "large.json"))).toBe(encodeText(large).byteLength);
    });
  });

  test("keeps UTF-8 intact for multibyte content", async () => {
    await withDir("fs-", async (root) => {
        const content = '{"k":"日本語 ✓ 🎉"}';
        await writeText(join(root, "unicode.json"), content);
        expect(readText(join(root, "unicode.json"))).toBe(content);
        await writeBytes(join(root, "bytes.json"), encodeText(content));
        expect(readText(join(root, "bytes.json"))).toBe(content);
    });
  });

  test("remove is idempotent and leaves directories alone", async () => {
    await withDir("fs-", async (root) => {
        await writeText(join(root, "a.json"), "{}");
        await remove(join(root, "a.json"));
        expect(exists(join(root, "a.json"))).toBe(false);
        await remove(join(root, "a.json"));
        await remove(join(root, "absent.json"));
        await remove(root);
        expect(isDirectory(root)).toBe(true);
    });
  });

  test("rename moves content and drops the source", async () => {
    await withDir("fs-", async (root) => {
        await writeText(join(root, "from.json"), '{"a":1}');
        await rename(join(root, "from.json"), join(root, "nested", "to.json"));
        expect(exists(join(root, "from.json"))).toBe(false);
        expect(readText(join(root, "nested", "to.json"))).toBe('{"a":1}');
    });
  });

  test("lists JSON files recursively and tolerates missing roots", async () => {
    await withDir("fs-", async (root) => {
        await writeText(join(root, "a.json"), "{}");
        await writeText(join(root, "nested", "b.json"), "{}");
        await writeText(join(root, "nested", "note.txt"), "");
        expect(listJson(root)).toEqual(["a.json", "nested/b.json"]);
        expect(listJson(join(root, "absent"))).toEqual([]);
        expect(listJson(join(root, "a.json"))).toEqual([]);
        expect(listFiles(root, "*.txt")).toEqual([]);
        expect(listFiles(join(root, "nested"), "*.txt")).toEqual(["note.txt"]);
    });
  });

  test("exposes typed read and write effects", async () => {
    await withDir("fs-", async (root) => {
        const written = await Effect.runPromise(saveText(join(root, "a.json"), '{"a":1}'));
        expect(written).toBeUndefined();
        expect(await Effect.runPromise(loadText(join(root, "a.json")))).toBe('{"a":1}');
        expect(await Effect.runPromise(loadJson(join(root, "a.json")))).toEqual({ a: 1 });

        const missing = await Effect.runPromise(Effect.exit(loadText(join(root, "absent.json"))));
        expect(Exit.isFailure(missing)).toBe(true);

        await writeText(join(root, "bad.json"), "{ oops");
        const invalid = await Effect.runPromise(Effect.exit(loadJson(join(root, "bad.json"))));
        expect(Exit.isFailure(invalid)).toBe(true);
    });
  });

  test("hashes, compresses, and decrypts with Bun primitives", async () => {
    expect(sha256Hex("x")).toBe(
      "2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881"
    );
    expect(decodeText(gunzip(gzip(encodeText("roundtrip"))))).toBe("roundtrip");
    expect(fromHex("0011ff")).toEqual(new Uint8Array([0x00, 0x11, 0xff]));

    const key = crypto.getRandomValues(new Uint8Array(32));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const cryptoKey = await crypto.subtle.importKey("raw", key as unknown as ArrayBuffer, "AES-GCM", false, [
      "encrypt",
    ]);
    const plain = encodeText("secret");
    const sealed = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: iv as unknown as ArrayBuffer, tagLength: 128 },
        cryptoKey,
        plain as unknown as ArrayBuffer
      )
    );
    expect(decodeText(await decryptAes(key, iv, sealed))).toBe("secret");
  });
});
