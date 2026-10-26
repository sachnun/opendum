import { describe, expect, it } from "bun:test";

import {
  addParams,
  addParam,
  statusTag,
  statusText,
  isRecoverable,
  normalizeEndpoint,
  parseParams,
  stripStatus,
} from "~~/lib/account-errors";

describe("account error helpers", () => {
  it("maps status codes", () => {
    expect(statusText(404)).toBe("Not Found");
    expect(statusText(999)).toBe("HTTP Error");
    expect(statusTag(429)).toEqual({ code: 429, label: "Rate Limit" });
    expect(statusTag(null)).toBe(null);
  });

  it("strips status prefixes from messages", () => {
    expect(stripStatus("[429] error: too many requests", 429)).toBe("too many requests");
    expect(stripStatus("Error: boom", null)).toBe("boom");
  });

  it("normalizes endpoints and parses parameters", () => {
    expect(normalizeEndpoint("/v1/messages")).toBe("messages");
    expect(normalizeEndpoint("chat/completions")).toBe("chat_completions");
    expect(normalizeEndpoint("nope")).toBe(null);
    expect(parseParams('{"a":1}')).toEqual({ a: 1 });
    expect(parseParams("[1,2]")).toBe(null);
    expect(parseParams("")).toBe(null);
  });

  it("builds playground query parameters", () => {
    const query: Record<string, string> = {};
    addParam(query, { temperature: 0.5 }, "temperature");
    expect(query.temperature).toBe("0.5");
    addParams(query, { temperature: 1, top_k: 5 });
    expect(query.additional_parameters).toBe('{"top_k":5}');
  });

  it("detects recoverable codes", () => {
    expect(isRecoverable(429)).toBe(true);
    expect(isRecoverable(502)).toBe(true);
    expect(isRecoverable(400)).toBe(false);
  });
});
