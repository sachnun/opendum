import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  responsesFunctionCallItem,
  responsesMessageItem,
  responsesReasoningItem,
  responsesUsageFromChat,
  toChatCallId,
  toResponsesApiId,
} from "#providers/transform/responses-core.ts";

describe("toResponsesApiId", () => {
  it("keeps already-prefixed ids", () => {
    assert.equal(toResponsesApiId("fc_abc"), "fc_abc");
    assert.equal(toResponsesApiId("fc-abc"), "fc-abc");
    assert.equal(toResponsesApiId("apc_abc"), "apc_abc");
  });

  it("converts call ids to function call ids", () => {
    assert.equal(toResponsesApiId("call_123"), "fc_123");
    assert.equal(toResponsesApiId("raw"), "fc_raw");
  });

  it("generates an id for an empty value", () => {
    assert.match(toResponsesApiId(""), /^fc_[0-9a-f]{32}$/);
  });
});

describe("toChatCallId", () => {
  it("keeps and normalizes call ids", () => {
    assert.equal(toChatCallId("call_123"), "call_123");
    assert.equal(toChatCallId("fc_123"), "call_123");
    assert.equal(toChatCallId("fc-123"), "call_123");
    assert.equal(toChatCallId("raw"), "call_raw");
  });

  it("generates an id for an empty value", () => {
    assert.match(toChatCallId(""), /^call_[0-9a-f]{32}$/);
  });
});

describe("responses item builders", () => {
  it("builds a reasoning item", () => {
    const item = responsesReasoningItem("because");
    assert.match(String(item.id), /^rs_[0-9a-f]{32}$/);
    assert.equal(item.type, "reasoning");
    assert.equal(item.status, "completed");
    assert.deepEqual(item.summary, [{ type: "summary_text", text: "because" }]);
  });

  it("builds a message item", () => {
    const item = responsesMessageItem("hello");
    assert.match(String(item.id), /^msg_[0-9a-f]{32}$/);
    assert.equal(item.type, "message");
    assert.equal(item.role, "assistant");
    assert.deepEqual(item.content, [{ type: "output_text", text: "hello", annotations: [] }]);
  });

  it("builds a function call item with a json argument fallback", () => {
    const withArgs = responsesFunctionCallItem("fc_1", "lookup", '{"q":"x"}');
    assert.equal(withArgs.call_id, "fc_1");
    assert.equal(withArgs.arguments, '{"q":"x"}');
    const withoutArgs = responsesFunctionCallItem("fc_2", "lookup", "");
    assert.equal(withoutArgs.arguments, "{}");
  });
});

describe("responsesUsageFromChat", () => {
  it("maps chat usage including cache and reasoning details", () => {
    assert.deepEqual(
      responsesUsageFromChat({
        prompt_tokens: 10,
        completion_tokens: 5,
        prompt_tokens_details: { cached_tokens: 3, cache_write_tokens: 1 },
        completion_tokens_details: { reasoning_tokens: 2 },
      }),
      {
        input_tokens: 10,
        input_tokens_details: { cached_tokens: 3, cache_write_tokens: 1 },
        output_tokens: 5,
        output_tokens_details: { reasoning_tokens: 2 },
        total_tokens: 15,
      }
    );
  });

  it("coerces numeric strings and defaults missing details", () => {
    assert.deepEqual(responsesUsageFromChat({ prompt_tokens: "10", completion_tokens: "5" }), {
      input_tokens: 10,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      output_tokens: 5,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 15,
    });
  });
});
