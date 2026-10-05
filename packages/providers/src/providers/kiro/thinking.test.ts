import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  findKiroRealTag,
  findKiroThinkingStartTag,
  KiroThinkingSplitter,
  maxKiroThinkingStartLen,
  safeKiroUtf8PrefixLen,
} from "#providers/providers/kiro/thinking.ts";

describe("safeKiroUtf8PrefixLen", () => {
  it("bounds the length", () => {
    assert.equal(safeKiroUtf8PrefixLen("abcdef", 3), 3);
    assert.equal(safeKiroUtf8PrefixLen("abc", 10), 3);
    assert.equal(safeKiroUtf8PrefixLen("abc", 0), 0);
    assert.equal(safeKiroUtf8PrefixLen("abc", -1), 0);
  });

  it("does not split inside a multibyte character", () => {
    const value = "a\u00e9"; // "aé"
    assert.equal(safeKiroUtf8PrefixLen(value, 1), 1);
    assert.equal(safeKiroUtf8PrefixLen(value, 2), 2);
  });
});

describe("tag discovery", () => {
  it("finds the earliest supported start tag", () => {
    assert.deepEqual(findKiroThinkingStartTag("hello <thinking> world"), {
      start: 6,
      tag: { start: "<thinking>", end: "</thinking>" },
    });
    assert.deepEqual(findKiroThinkingStartTag("x<think>y"), {
      start: 1,
      tag: { start: "<think>", end: "</think>" },
    });
    assert.deepEqual(findKiroThinkingStartTag("no tags"), { start: -1, tag: null });
  });

  it("reports the maximum start tag length", () => {
    assert.equal(maxKiroThinkingStartLen(), "<reasoning>".length);
  });

  it("finds a plain tag", () => {
    assert.equal(findKiroRealTag("hello <thinking>", "<thinking>"), 6);
    assert.equal(findKiroRealTag("none", "<thinking>"), -1);
  });

  it("ignores a tag inside an unclosed code fence", () => {
    assert.equal(findKiroRealTag("```\n<thinking>", "<thinking>"), -1);
  });
});

describe("KiroThinkingSplitter", () => {
  it("splits reasoning from content", () => {
    const splitter = new KiroThinkingSplitter(true);
    assert.deepEqual(splitter.process("<thinking>why</thinking>hello", true), ["hello", "why"]);
  });

  it("buffers a partial start tag across chunks", () => {
    const splitter = new KiroThinkingSplitter(true);
    assert.deepEqual(splitter.process("plain ", true), ["plain ", ""]);
    assert.deepEqual(splitter.process("<thin", false), ["", ""]);
    assert.deepEqual(splitter.process("king>", false), ["", ""]);
    assert.deepEqual(splitter.process("why", true), ["", "why"]);
  });

  it("emits content after a closed reasoning block", () => {
    const splitter = new KiroThinkingSplitter(false);
    assert.deepEqual(splitter.process("<think>a</think>b", true), ["b", "a"]);
  });

  it("treats a trailing unterminated block as reasoning on final flush", () => {
    const splitter = new KiroThinkingSplitter(true);
    assert.deepEqual(splitter.flush(), ["", ""]);
    assert.deepEqual(splitter.process("<thinking>open", false), ["", ""]);
    assert.deepEqual(splitter.flush(), ["", "open"]);
  });
});
