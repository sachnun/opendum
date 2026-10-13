import { describe, expect, it } from "bun:test";

import {
  addAdditionalPlaygroundParams,
  addPlaygroundParam,
  getErrorStatusTag,
  getHttpStatusDescription,
  isImmediatelyRecoverableErrorCode,
  normalizePlaygroundEndpoint,
  parseErrorParameters,
  stripStatusFromErrorMessage,
} from "./account-errors";

describe("account error helpers", () => {
  it("maps status codes", () => {
    expect(getHttpStatusDescription(404)).toBe("Not Found");
    expect(getHttpStatusDescription(999)).toBe("HTTP Error");
    expect(getErrorStatusTag(429)).toEqual({ code: 429, label: "Rate Limit" });
    expect(getErrorStatusTag(null)).toBe(null);
  });

  it("strips status prefixes from messages", () => {
    expect(stripStatusFromErrorMessage("[429] error: too many requests", 429)).toBe("too many requests");
    expect(stripStatusFromErrorMessage("Error: boom", null)).toBe("boom");
  });

  it("normalizes endpoints and parses parameters", () => {
    expect(normalizePlaygroundEndpoint("/v1/messages")).toBe("messages");
    expect(normalizePlaygroundEndpoint("chat/completions")).toBe("chat_completions");
    expect(normalizePlaygroundEndpoint("nope")).toBe(null);
    expect(parseErrorParameters('{"a":1}')).toEqual({ a: 1 });
    expect(parseErrorParameters("[1,2]")).toBe(null);
    expect(parseErrorParameters("")).toBe(null);
  });

  it("builds playground query parameters", () => {
    const query: Record<string, string> = {};
    addPlaygroundParam(query, { temperature: 0.5 }, "temperature");
    expect(query.temperature).toBe("0.5");
    addAdditionalPlaygroundParams(query, { temperature: 1, top_k: 5 });
    expect(query.additional_parameters).toBe('{"top_k":5}');
  });

  it("detects recoverable codes", () => {
    expect(isImmediatelyRecoverableErrorCode(429)).toBe(true);
    expect(isImmediatelyRecoverableErrorCode(502)).toBe(true);
    expect(isImmediatelyRecoverableErrorCode(400)).toBe(false);
  });
});
