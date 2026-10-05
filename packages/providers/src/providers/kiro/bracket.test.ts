import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  cleanKiroBracketToolCalls,
  findBalancedJsonEnd,
  parseKiroBracketToolCalls,
} from "#providers/providers/kiro/bracket.ts";

describe("findBalancedJsonEnd", () => {
  it("finds the matching brace", () => {
    assert.equal(findBalancedJsonEnd('{"a":1}', 0), 6);
    assert.equal(findBalancedJsonEnd('{"a":{"b":[1,2]}}', 0), 16);
  });

  it("ignores braces inside strings and escapes", () => {
    assert.equal(findBalancedJsonEnd('{"a":"}{"}', 0), 9);
    assert.equal(findBalancedJsonEnd('{"k":"\\"}"}', 0), 10);
  });

  it("returns -1 for unbalanced input", () => {
    assert.equal(findBalancedJsonEnd('{"a":1', 0), -1);
  });
});

describe("parseKiroBracketToolCalls", () => {
  it("parses a single call", () => {
    const text = 'before [Called lookup with args: {"q":"x"}] after';
    const calls = parseKiroBracketToolCalls(text);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.name, "lookup");
    assert.equal(calls[0]!.arguments, '{"q":"x"}');
    assert.equal(calls[0]!.raw, '[Called lookup with args: {"q":"x"}]');
    assert.match(calls[0]!.id, /^toolu/);
    assert.equal(cleanKiroBracketToolCalls(text, calls), "before after");
  });

  it("parses multiple calls and nested args", () => {
    const two = '[Called a with args: {"x":1}] and [Called b with args: {"y":{"z":2}}]';
    const calls = parseKiroBracketToolCalls(two);
    assert.deepEqual(calls.map((call) => call.name), ["a", "b"]);
    assert.equal(calls[1]!.arguments, '{"y":{"z":2}}');
  });

  it("tolerates whitespace around args", () => {
    const calls = parseKiroBracketToolCalls('[Called a with args:\n   {"x":1}\n]');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.arguments, '{"x":1}');
  });

  it("skips malformed calls", () => {
    assert.deepEqual(parseKiroBracketToolCalls('[Called a with args: {"x":1}'), []);
    assert.deepEqual(parseKiroBracketToolCalls('[Called a with args: {bad}]'), []);
    assert.deepEqual(parseKiroBracketToolCalls('[Called a with args: nope]'), []);
    assert.deepEqual(parseKiroBracketToolCalls('[Called a something'), []);
    assert.deepEqual(parseKiroBracketToolCalls("no calls here"), []);
    assert.deepEqual(parseKiroBracketToolCalls('[Called f with args: {"a":1]'), []);
  });
});

describe("cleanKiroBracketToolCalls", () => {
  it("removes calls and collapses whitespace", () => {
    const text = 'a [Called f with args: {"x":1}]   b';
    const calls = parseKiroBracketToolCalls(text);
    assert.equal(cleanKiroBracketToolCalls(text, calls), "a b");
  });
});
