import { describe, expect, test } from "bun:test";

import { basename, dirname, extname, fromFileUrl, join, moduleDir, relative, resolve, sep } from "./paths.ts";

describe("posix path helpers", () => {
  test("join matches node:path semantics", () => {
    expect(join("a", "b")).toBe("a/b");
    expect(join("/a", "b")).toBe("/a/b");
    expect(join("/a", "/b")).toBe("/a/b");
    expect(join("a", "..", "b")).toBe("b");
    expect(join("/a/b", "../c")).toBe("/a/c");
    expect(join("//a//b//", "c")).toBe("/a/b/c");
    expect(join("a", "")).toBe("a");
    expect(join("")).toBe(".");
    expect(join("/a/b/")).toBe("/a/b/");
  });

  test("dirname matches node:path semantics", () => {
    expect(dirname("a/b/c.json")).toBe("a/b");
    expect(dirname("a.json")).toBe(".");
    expect(dirname("/a.json")).toBe("/");
    expect(dirname("//a")).toBe("//");
    expect(dirname("a/b/")).toBe("a");
    expect(dirname("")).toBe(".");
  });

  test("basename and extname match node:path semantics", () => {
    expect(basename("/a/b/c.json")).toBe("c.json");
    expect(basename("/a/b/c.json", ".json")).toBe("c");
    expect(basename("a/b/")).toBe("b");
    expect(basename("/")).toBe("");
    expect(basename(".env", ".env")).toBe(".env");
    expect(extname("a.json")).toBe(".json");
    expect(extname("a.tar.gz")).toBe(".gz");
    expect(extname(".env")).toBe("");
    expect(extname("a")).toBe("");
    expect(extname("..")).toBe("");
  });

  test("resolve produces absolute paths", () => {
    expect(resolve("/a", "b")).toBe("/a/b");
    expect(resolve("/a/b", "../c")).toBe("/a/c");
    expect(resolve("/a/b", "/c/d")).toBe("/c/d");
    expect(resolve("/a")).toBe("/a");
    expect(resolve("/")).toBe("/");
  });

  test("relative walks between absolute paths", () => {
    expect(relative("/a", "/a/b")).toBe("b");
    expect(relative("/a/b", "/a")).toBe("..");
    expect(relative("/a/b", "/a/c")).toBe("../c");
    expect(relative("/a/b/c", "/a/d/e")).toBe("../../d/e");
    expect(relative("/a", "/a")).toBe("");
  });

  test("converts file URLs to paths", () => {
    expect(fromFileUrl("file:///tmp/a/b.json")).toBe("/tmp/a/b.json");
    expect(moduleDir("file:///tmp/a/script.ts")).toBe("/tmp/a");
    expect(sep).toBe("/");
  });
});
