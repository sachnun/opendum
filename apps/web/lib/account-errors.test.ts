import assert from "node:assert/strict";
import { describe, it } from "node:test";

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
    assert.equal(getHttpStatusDescription(404), "Not Found");
    assert.equal(getHttpStatusDescription(999), "HTTP Error");
    assert.deepEqual(getErrorStatusTag(429), { code: 429, label: "Rate Limit" });
    assert.equal(getErrorStatusTag(null), null);
  });

  it("strips status prefixes from messages", () => {
    assert.equal(stripStatusFromErrorMessage("[429] error: too many requests", 429), "too many requests");
    assert.equal(stripStatusFromErrorMessage("Error: boom", null), "boom");
  });

  it("normalizes endpoints and parses parameters", () => {
    assert.equal(normalizePlaygroundEndpoint("/v1/messages"), "messages");
    assert.equal(normalizePlaygroundEndpoint("chat/completions"), "chat_completions");
    assert.equal(normalizePlaygroundEndpoint("nope"), null);
    assert.deepEqual(parseErrorParameters('{"a":1}'), { a: 1 });
    assert.equal(parseErrorParameters("[1,2]"), null);
    assert.equal(parseErrorParameters(""), null);
  });

  it("builds playground query parameters", () => {
    const query: Record<string, string> = {};
    addPlaygroundParam(query, { temperature: 0.5 }, "temperature");
    assert.equal(query.temperature, "0.5");
    addAdditionalPlaygroundParams(query, { temperature: 1, top_k: 5 });
    assert.equal(query.additional_parameters, '{"top_k":5}');
  });

  it("detects recoverable codes", () => {
    assert.equal(isImmediatelyRecoverableErrorCode(429), true);
    assert.equal(isImmediatelyRecoverableErrorCode(502), true);
    assert.equal(isImmediatelyRecoverableErrorCode(400), false);
  });
});
