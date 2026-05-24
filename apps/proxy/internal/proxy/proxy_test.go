package proxy

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/opendum/opendum/apps/proxy/internal/auth"
	appdb "github.com/opendum/opendum/apps/proxy/internal/db"
	"github.com/opendum/opendum/apps/proxy/internal/models"
	"github.com/opendum/opendum/apps/proxy/internal/providers"
)

func TestParseChatCompletionsBuildsProviderPayload(t *testing.T) {
	messages := []any{map[string]any{"role": "user", "content": "hello"}}
	body := map[string]any{
		"model":            "alias-model",
		"messages":         messages,
		"stream":           false,
		"temperature":      0.7,
		"reasoning_effort": "high",
	}

	parsed, routeErr := parseChatCompletions(body)
	if routeErr != nil {
		t.Fatalf("parseChatCompletions returned error: %+v", routeErr)
	}
	if parsed.ModelParam != "alias-model" {
		t.Fatalf("ModelParam = %q, want alias-model", parsed.ModelParam)
	}
	if parsed.Stream {
		t.Fatal("Stream = true, want false")
	}
	if parsed.ForcedAccountID != nil {
		t.Fatalf("ForcedAccountID = %v, want nil", parsed.ForcedAccountID)
	}
	if !parsed.ReasoningRequested {
		t.Fatal("ReasoningRequested = false, want true")
	}
	if parsed.ParamsForError["model"] != nil || parsed.ParamsForError["messages"] != nil {
		t.Fatalf("ParamsForError contains request-only fields: %#v", parsed.ParamsForError)
	}
	if parsed.ParamsForError["stream"] != false {
		t.Fatalf("ParamsForError missing stream: %#v", parsed.ParamsForError)
	}

	payload := buildChatCompletions(parsed, "canonical-model", true, "sess_1")
	if payload["model"] != "canonical-model" {
		t.Fatalf("payload model = %q, want canonical-model", payload["model"])
	}
	if !reflect.DeepEqual(payload["messages"], parsed.RouteData["messages"]) {
		t.Fatal("payload messages did not preserve parsed messages")
	}
	if payload["stream"] != true {
		t.Fatalf("payload stream = %v, want true", payload["stream"])
	}
	if payload["_includeReasoning"] != true || payload["_sessionId"] != "sess_1" {
		t.Fatalf("payload missing proxy metadata: %#v", payload)
	}
	if payload["temperature"] != 0.7 || payload["reasoning_effort"] != "high" {
		t.Fatalf("payload dropped provider params: %#v", payload)
	}
}

func TestParseChatCompletionsValidation(t *testing.T) {
	tests := []struct {
		name    string
		body    map[string]any
		message string
	}{
		{name: "missing model", body: map[string]any{"messages": []any{"hello"}}, message: "model is required"},
		{name: "missing messages", body: map[string]any{"model": "test-model"}, message: "messages array is required"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, routeErr := parseChatCompletions(tt.body)
			if routeErr == nil {
				t.Fatal("parseChatCompletions returned nil error")
			}
			if routeErr.Status != http.StatusBadRequest || routeErr.Message != tt.message || routeErr.Type != "invalid_request_error" {
				t.Fatalf("routeErr = %+v", routeErr)
			}
		})
	}
}

func TestParseChatCompletionsAcceptsEmptyMessages(t *testing.T) {
	parsed, routeErr := parseChatCompletions(map[string]any{"model": "test-model", "messages": []any{}})
	if routeErr != nil {
		t.Fatalf("parseChatCompletions returned error: %+v", routeErr)
	}
	if parsed.Stream {
		t.Fatal("Stream = true, want default false")
	}

	payload := buildChatCompletions(parsed, "test-model", false, "")
	messages, ok := payload["messages"].([]any)
	if !ok || len(messages) != 0 {
		t.Fatalf("payload messages = %#v, want empty array", payload["messages"])
	}
}

func TestParseChatCompletionsReasoningNoneDoesNotRequestReasoning(t *testing.T) {
	parsed, routeErr := parseChatCompletions(map[string]any{
		"model":            "test-model",
		"messages":         []any{},
		"reasoning_effort": "none",
	})
	if routeErr != nil {
		t.Fatalf("parseChatCompletions returned error: %+v", routeErr)
	}
	if parsed.ReasoningRequested {
		t.Fatal("ReasoningRequested = true, want false")
	}

	payload := buildChatCompletions(parsed, "test-model", false, "")
	if payload["_includeReasoning"] != false {
		t.Fatalf("payload _includeReasoning = %#v, want false", payload["_includeReasoning"])
	}
}

func TestApplyModelAccountSelectorUsesNonProviderPrefix(t *testing.T) {
	service := &Service{providerRegistry: providers.NewRegistry(nil, nil, nil)}
	parsed := service.applyModelAccountSelector(parsedEndpointRequest{ModelParam: "acct_1/claude-opus-4-6"})

	if parsed.ModelParam != "claude-opus-4-6" {
		t.Fatalf("ModelParam = %q, want claude-opus-4-6", parsed.ModelParam)
	}
	if parsed.ForcedAccountID == nil || *parsed.ForcedAccountID != "acct_1" {
		t.Fatalf("ForcedAccountID = %v, want acct_1", parsed.ForcedAccountID)
	}
}

func TestApplyModelAccountSelectorPreservesProviderPrefix(t *testing.T) {
	service := &Service{providerRegistry: providers.NewRegistry(nil, nil, nil)}
	parsed := service.applyModelAccountSelector(parsedEndpointRequest{ModelParam: "openrouter/claude-opus-4-6"})

	if parsed.ModelParam != "openrouter/claude-opus-4-6" {
		t.Fatalf("ModelParam = %q, want provider-prefixed model", parsed.ModelParam)
	}
	if parsed.ForcedAccountID != nil {
		t.Fatalf("ForcedAccountID = %v, want nil", parsed.ForcedAccountID)
	}
}

func TestParseResponsesConvertsInputAndParams(t *testing.T) {
	input := []any{
		map[string]any{"type": "message", "role": "developer", "content": "follow policy"},
		map[string]any{"type": "message", "role": "user", "content": "what time is it?"},
		map[string]any{"type": "function_call", "call_id": "fc_weather", "name": "weather", "arguments": `{"city":"Jakarta"}`},
		map[string]any{"type": "function_call_output", "call_id": "fc_weather", "output": "sunny"},
	}
	body := map[string]any{
		"model":             "responses-model",
		"input":             input,
		"instructions":      "system instructions",
		"max_output_tokens": 123,
		"stream":            false,
		"reasoning":         map[string]any{"effort": "medium"},
	}

	parsed, routeErr := parseResponses(body)
	if routeErr != nil {
		t.Fatalf("parseResponses returned error: %+v", routeErr)
	}
	if parsed.ModelParam != "responses-model" || parsed.Stream {
		t.Fatalf("parsed request = %+v", parsed)
	}
	if !parsed.ReasoningRequested {
		t.Fatal("ReasoningRequested = false, want true")
	}
	messages := parsed.RouteData["messages"].([]any)
	if len(messages) != 5 {
		t.Fatalf("converted messages len = %d, want 5: %#v", len(messages), messages)
	}
	assertMessage(t, messages[0], "system", "system instructions")
	assertMessage(t, messages[1], "system", "follow policy")
	assertMessage(t, messages[2], "user", "what time is it?")

	assistant := messages[3].(map[string]any)
	if assistant["role"] != "assistant" || assistant["content"] != "" {
		t.Fatalf("assistant tool-call message = %#v", assistant)
	}
	toolCalls := assistant["tool_calls"].([]any)
	if len(toolCalls) != 1 {
		t.Fatalf("tool_calls len = %d, want 1", len(toolCalls))
	}
	call := toolCalls[0].(map[string]any)
	if call["id"] != "call_weather" {
		t.Fatalf("tool call id = %q, want call_weather", call["id"])
	}
	function := call["function"].(map[string]any)
	if function["name"] != "weather" || function["arguments"] != `{"city":"Jakarta"}` {
		t.Fatalf("tool call function = %#v", function)
	}
	assertMessage(t, messages[4], "tool", "sunny")
	if messages[4].(map[string]any)["tool_call_id"] != "call_weather" {
		t.Fatalf("tool result id = %q, want call_weather", messages[4].(map[string]any)["tool_call_id"])
	}

	params := parsed.RouteData["params"].(map[string]any)
	if _, ok := params["max_output_tokens"]; ok {
		t.Fatalf("params still contains max_output_tokens: %#v", params)
	}
	if params["max_tokens"] != 123 {
		t.Fatalf("max_tokens = %v, want 123", params["max_tokens"])
	}

	payload := buildResponses(parsed, "canonical-responses-model", true, "sess_2")
	if payload["model"] != "canonical-responses-model" || payload["stream"] != true {
		t.Fatalf("payload = %#v", payload)
	}
	if payload["_responsesInput"] == nil || payload["_sessionId"] != "sess_2" || payload["_includeReasoning"] != true {
		t.Fatalf("payload missing response metadata: %#v", payload)
	}
}

func TestParseResponsesValidation(t *testing.T) {
	_, routeErr := parseResponses(map[string]any{"model": "test-model"})
	if routeErr == nil {
		t.Fatal("parseResponses returned nil error")
	}
	if routeErr.Status != http.StatusBadRequest || routeErr.Message != "input array is required" || routeErr.Type != "invalid_request_error" {
		t.Fatalf("routeErr = %+v", routeErr)
	}
}

func TestParseResponsesAcceptsEmptyInput(t *testing.T) {
	parsed, routeErr := parseResponses(map[string]any{"model": "test-model", "input": []any{}})
	if routeErr != nil {
		t.Fatalf("parseResponses returned error: %+v", routeErr)
	}
	if parsed.Stream {
		t.Fatal("Stream = true, want default false")
	}

	payload := buildResponses(parsed, "test-model", false, "")
	messages, ok := payload["messages"].([]any)
	if !ok || len(messages) != 0 {
		t.Fatalf("payload messages = %#v, want empty array", payload["messages"])
	}
	input, ok := payload["_responsesInput"].([]any)
	if !ok || len(input) != 0 {
		t.Fatalf("payload _responsesInput = %#v, want empty array", payload["_responsesInput"])
	}
}

func TestTransformAnthropicToOpenAI(t *testing.T) {
	body := map[string]any{
		"system": []any{
			map[string]any{"type": "text", "text": "first"},
			map[string]any{"type": "text", "text": "second"},
		},
		"tools": []any{
			map[string]any{
				"name":        "lookup",
				"description": "look up a city",
				"input_schema": map[string]any{
					"type":       "object",
					"properties": map[string]any{"city": map[string]any{"type": "string"}},
				},
			},
		},
		"tool_choice": map[string]any{"type": "tool", "name": "lookup"},
		"messages": []any{
			map[string]any{
				"role": "user",
				"content": []any{
					map[string]any{"type": "text", "text": "look"},
					map[string]any{"type": "image", "source": map[string]any{"url": "data:image/png;base64,abc"}},
				},
			},
			map[string]any{
				"role": "assistant",
				"content": []any{
					map[string]any{"type": "tool_use", "id": "toolu_1", "name": "lookup", "input": map[string]any{"city": "Jakarta"}},
					map[string]any{"type": "tool_use", "id": "toolu_unmatched", "name": "lookup", "input": map[string]any{"city": "Paris"}},
				},
			},
			map[string]any{
				"role": "user",
				"content": []any{
					map[string]any{"type": "tool_result", "tool_use_id": "toolu_1", "content": map[string]any{"ok": true}},
				},
			},
		},
		"max_tokens": 100,
		"thinking":   map[string]any{"type": "enabled", "budget_tokens": 2048},
	}

	payload := transformAnthropicToOpenAI(body)
	if payload["max_tokens"] != 100 || payload["thinking_budget"] != 2048 || payload["_includeReasoning"] != true {
		t.Fatalf("payload missing params: %#v", payload)
	}
	tools := payload["tools"].([]any)
	if len(tools) != 1 {
		t.Fatalf("tools len = %d, want 1", len(tools))
	}
	tool := tools[0].(map[string]any)
	function := tool["function"].(map[string]any)
	if tool["type"] != "function" || function["name"] != "lookup" || function["description"] != "look up a city" {
		t.Fatalf("converted tool = %#v", tool)
	}
	if !reflect.DeepEqual(function["parameters"], body["tools"].([]any)[0].(map[string]any)["input_schema"]) {
		t.Fatalf("tool parameters = %#v", function["parameters"])
	}
	toolChoice := payload["tool_choice"].(map[string]any)
	choiceFn := toolChoice["function"].(map[string]any)
	if toolChoice["type"] != "function" || choiceFn["name"] != "lookup" {
		t.Fatalf("tool_choice = %#v", toolChoice)
	}

	messages := payload["messages"].([]any)
	if len(messages) != 4 {
		t.Fatalf("messages len = %d, want 4: %#v", len(messages), messages)
	}
	assertMessage(t, messages[0], "system", "first\nsecond")

	user := messages[1].(map[string]any)
	if user["role"] != "user" {
		t.Fatalf("user role = %q", user["role"])
	}
	parts := user["content"].([]any)
	if len(parts) != 2 {
		t.Fatalf("user content parts len = %d, want 2", len(parts))
	}
	if parts[0].(map[string]any)["type"] != "text" || parts[1].(map[string]any)["type"] != "image_url" {
		t.Fatalf("unexpected user parts: %#v", parts)
	}

	assistant := messages[2].(map[string]any)
	if assistant["role"] != "assistant" || assistant["content"] != nil {
		t.Fatalf("assistant message = %#v", assistant)
	}
	toolCalls := assistant["tool_calls"].([]any)
	if len(toolCalls) != 1 {
		t.Fatalf("tool_calls len = %d, want 1", len(toolCalls))
	}
	call := toolCalls[0].(map[string]any)
	if call["id"] != "toolu_1" || call["type"] != "function" {
		t.Fatalf("tool call = %#v", call)
	}
	fn := call["function"].(map[string]any)
	if fn["name"] != "lookup" || fn["arguments"] != `{"city":"Jakarta"}` {
		t.Fatalf("tool function = %#v", fn)
	}

	assertMessage(t, messages[3], "tool", `{"ok":true}`)
	if messages[3].(map[string]any)["tool_call_id"] != "toolu_1" {
		t.Fatalf("tool result id = %q, want toolu_1", messages[3].(map[string]any)["tool_call_id"])
	}
}

func TestTransformAnthropicToOpenAIDefaultMaxTokens(t *testing.T) {
	payload := transformAnthropicToOpenAI(map[string]any{
		"messages": []any{map[string]any{"role": "user", "content": "hello"}},
	})

	if payload["max_tokens"] != 4096 {
		t.Fatalf("max_tokens = %v, want 4096", payload["max_tokens"])
	}
}

func TestTransformAnthropicAdaptiveThinkingMapsToReasoningEffort(t *testing.T) {
	payload := transformAnthropicToOpenAI(map[string]any{
		"model":         "claude-opus-4-7",
		"messages":      []any{map[string]any{"role": "user", "content": "hello"}},
		"thinking":      map[string]any{"type": "adaptive"},
		"output_config": map[string]any{"effort": "xhigh"},
	})

	if payload["reasoning_effort"] != "xhigh" || payload["_includeReasoning"] != true {
		t.Fatalf("payload missing adaptive thinking metadata: %#v", payload)
	}
	if payload["thinking"] != nil || payload["output_config"] != nil || payload["thinking_budget"] != nil {
		t.Fatalf("payload leaked Anthropic-only thinking params: %#v", payload)
	}
}

func TestTransformAnthropicToolChoiceVariants(t *testing.T) {
	tests := []struct {
		name string
		in   map[string]any
		want any
	}{
		{name: "auto", in: map[string]any{"type": "auto"}, want: "auto"},
		{name: "any", in: map[string]any{"type": "any"}, want: "required"},
		{name: "none", in: map[string]any{"type": "none"}, want: "none"},
		{name: "tool", in: map[string]any{"type": "tool", "name": "lookup"}, want: map[string]any{"type": "function", "function": map[string]any{"name": "lookup"}}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			payload := transformAnthropicToOpenAI(map[string]any{
				"messages":    []any{map[string]any{"role": "user", "content": "hello"}},
				"tool_choice": tt.in,
			})
			if !reflect.DeepEqual(payload["tool_choice"], tt.want) {
				t.Fatalf("tool_choice = %#v, want %#v", payload["tool_choice"], tt.want)
			}
		})
	}
}

func TestTransformOpenAIToAnthropic(t *testing.T) {
	openAI := map[string]any{
		"id": "chatcmpl_1",
		"choices": []any{map[string]any{
			"finish_reason": "tool_calls",
			"message": map[string]any{
				"reasoning_content": "thought process",
				"content":           "final answer",
				"tool_calls": []any{map[string]any{
					"id": "call_1",
					"function": map[string]any{
						"name":      "search",
						"arguments": `{"q":"go"}`,
					},
				}},
			},
		}},
		"usage": map[string]any{"prompt_tokens": 9, "completion_tokens": 4},
	}

	response := transformOpenAIToAnthropic(openAI, "claude-test")
	if response["id"] != "msg_chatcmpl_1" || response["model"] != "claude-test" || response["stop_reason"] != "tool_use" {
		t.Fatalf("response metadata = %#v", response)
	}
	content := response["content"].([]any)
	if len(content) != 3 {
		t.Fatalf("content len = %d, want 3: %#v", len(content), content)
	}
	if content[0].(map[string]any)["type"] != "thinking" || content[0].(map[string]any)["thinking"] != "thought process" {
		t.Fatalf("thinking block = %#v", content[0])
	}
	if content[1].(map[string]any)["type"] != "text" || content[1].(map[string]any)["text"] != "final answer" {
		t.Fatalf("text block = %#v", content[1])
	}
	toolUse := content[2].(map[string]any)
	if toolUse["type"] != "tool_use" || toolUse["id"] != "call_1" || toolUse["name"] != "search" {
		t.Fatalf("tool use block = %#v", toolUse)
	}
	if !reflect.DeepEqual(toolUse["input"], map[string]any{"q": "go"}) {
		t.Fatalf("tool input = %#v", toolUse["input"])
	}
	usage := response["usage"].(map[string]any)
	if usage["input_tokens"] != 9 || usage["output_tokens"] != 4 {
		t.Fatalf("usage = %#v", usage)
	}
}

func TestTransformOpenAIToAnthropicIncludesUpstreamThinkingWhenRequestDisabled(t *testing.T) {
	openAI := map[string]any{"choices": []any{map[string]any{"message": map[string]any{"reasoning_content": "thought process", "content": "final answer"}}}}

	response := transformOpenAIToAnthropic(openAI, "claude-test")
	content := response["content"].([]any)
	if len(content) != 2 {
		t.Fatalf("content len = %d, want 2: %#v", len(content), content)
	}
	if content[0].(map[string]any)["type"] != "thinking" || content[0].(map[string]any)["thinking"] != "thought process" {
		t.Fatalf("thinking block = %#v", content[0])
	}
}

func TestStripImageContent(t *testing.T) {
	payload := map[string]any{"messages": []any{
		map[string]any{"role": "user", "content": []any{
			map[string]any{"type": "text", "text": "keep"},
			map[string]any{"type": "image_url", "image_url": map[string]any{"url": "https://example.com/a.png"}},
			"raw-part",
		}},
		map[string]any{"role": "user", "content": []any{
			map[string]any{"type": "text", "text": "collapse me"},
			map[string]any{"type": "input_image", "image_url": "ignored"},
		}},
	}, "_responsesInput": []any{
		map[string]any{"type": "message", "role": "user", "content": []any{
			map[string]any{"type": "input_text", "text": "keep responses text"},
			map[string]any{"type": "input_image", "image_url": "https://example.com/b.png"},
		}},
	}}

	stripImageContent(payload)
	messages := payload["messages"].([]any)
	first := messages[0].(map[string]any)["content"].([]any)
	if len(first) != 2 || first[0].(map[string]any)["type"] != "text" || first[1] != "raw-part" {
		t.Fatalf("first content = %#v", first)
	}
	second := messages[1].(map[string]any)["content"]
	if second != "collapse me" {
		t.Fatalf("second content = %#v, want collapse me", second)
	}
	responsesInput := payload["_responsesInput"].([]any)
	responsesContent := responsesInput[0].(map[string]any)["content"].([]any)
	if len(responsesContent) != 1 || responsesContent[0].(map[string]any)["type"] != "input_text" {
		t.Fatalf("responses content = %#v", responsesContent)
	}
}

func TestStripToolCallParameters(t *testing.T) {
	payload := map[string]any{
		"model":               "test-model",
		"messages":            []any{},
		"tools":               []any{map[string]any{"type": "function"}},
		"tool_choice":         "auto",
		"parallel_tool_calls": true,
	}

	stripToolCallParameters(payload)

	for _, key := range []string{"tools", "tool_choice", "parallel_tool_calls"} {
		if _, ok := payload[key]; ok {
			t.Fatalf("%s was not stripped: %#v", key, payload)
		}
	}
	if payload["model"] != "test-model" || payload["messages"] == nil {
		t.Fatalf("non-tool fields changed: %#v", payload)
	}
}

func TestSanitizedProxyError(t *testing.T) {
	tests := []struct {
		name        string
		status      int
		body        string
		wantMessage string
		wantType    string
	}{
		{name: "auth json error", status: http.StatusUnauthorized, body: `{"error":{"message":" invalid\napi key "}}`, wantMessage: "invalid api key", wantType: "authentication_error"},
		{name: "rate limit json error", status: http.StatusTooManyRequests, body: `{"error":{"message":" slow down "}}`, wantMessage: "slow down", wantType: "rate_limit_error"},
		{name: "server detail", status: http.StatusBadGateway, body: `{"detail":"upstream failed"}`, wantMessage: "upstream failed", wantType: "api_error"},
		{name: "nested json string", status: http.StatusBadRequest, body: `{"error":"{\"message\":\"nested failure\"}"}`, wantMessage: "nested failure", wantType: "invalid_request_error"},
		{name: "empty body fallback", status: http.StatusTeapot, body: ``, wantMessage: "I'm a teapot", wantType: "invalid_request_error"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			message, typ := sanitizedProxyError(tt.status, tt.body)
			if message != tt.wantMessage || typ != tt.wantType {
				t.Fatalf("sanitizedProxyError = (%q, %q), want (%q, %q)", message, typ, tt.wantMessage, tt.wantType)
			}
		})
	}
}

func TestNormalizeClientErrorTruncatesLongMessages(t *testing.T) {
	message := normalizeClientError("  " + strings.Repeat("a", 400) + "  ")
	if len(message) != 334 {
		t.Fatalf("len(message) = %d, want 334", len(message))
	}
	if !strings.HasSuffix(message, "...[truncated]") {
		t.Fatalf("message does not include truncation suffix: %q", message)
	}
}

func TestPassthroughUsageTrackerProcessesSplitSSE(t *testing.T) {
	tracker := &openAIStreamUsageTracker{}
	tracker.Process([]byte(`data: {"usage":{"prompt_tokens":3`))
	tracker.Process([]byte(`,"completion_tokens":4}}` + "\n\n"))
	tracker.Process([]byte(`data: {"usage":{"input_tokens":5,"output_tokens":6}}` + "\n\n"))
	tracker.Process([]byte("data: [DONE]\n\n"))

	if tracker.inputTokens != 5 || tracker.outputTokens != 6 {
		t.Fatalf("tokens = (%d, %d), want (5, 6)", tracker.inputTokens, tracker.outputTokens)
	}

	incomplete := &openAIStreamUsageTracker{}
	incomplete.Process([]byte(`data: {"usage":{"input_tokens":8,"output_tokens":9}}`))
	incomplete.Flush()
	if incomplete.inputTokens != 8 || incomplete.outputTokens != 9 {
		t.Fatalf("flushed tokens = (%d, %d), want (8, 9)", incomplete.inputTokens, incomplete.outputTokens)
	}
}

func TestAnthropicStreamTrackerTransformsOpenAIContentBlocks(t *testing.T) {
	recorder := httptest.NewRecorder()
	tracker := &anthropicStreamTracker{writer: recorder}

	tracker.Process(openAIStreamEvent(t, map[string]any{"choices": []any{map[string]any{"delta": map[string]any{"reasoning_content": "think"}}}}))
	tracker.Process(openAIStreamEvent(t, map[string]any{"choices": []any{map[string]any{"delta": map[string]any{"content": "answer"}}}}))
	tracker.Process(openAIStreamEvent(t, map[string]any{"choices": []any{map[string]any{"delta": map[string]any{"tool_calls": []any{map[string]any{"index": 0, "id": "call_1", "function": map[string]any{"name": "lookup", "arguments": `{"city"`}}}}}}}))
	tracker.Process(openAIStreamEvent(t, map[string]any{"choices": []any{map[string]any{"delta": map[string]any{"tool_calls": []any{map[string]any{"index": 0, "function": map[string]any{"arguments": `:"Paris"}`}}}}}}}))
	tracker.Process(openAIStreamEvent(t, map[string]any{"usage": map[string]any{"prompt_tokens": 11, "completion_tokens": 5}, "choices": []any{map[string]any{"delta": map[string]any{}, "finish_reason": "tool_calls"}}}))
	tracker.Finish()

	events := parseRecordedSSE(t, recorder.Body.String())
	if len(events) != 12 {
		t.Fatalf("events len = %d, want 12: %#v", len(events), events)
	}
	assertSSEEvent(t, events[0], "content_block_start", "thinking", 0)
	if delta := events[1].data["delta"].(map[string]any); delta["type"] != "thinking_delta" || delta["thinking"] != "think" {
		t.Fatalf("thinking delta = %#v", delta)
	}
	if events[2].event != "content_block_stop" || int(events[2].data["index"].(float64)) != 0 {
		t.Fatalf("thinking stop = %#v", events[2])
	}
	assertSSEEvent(t, events[3], "content_block_start", "text", 1)
	if delta := events[4].data["delta"].(map[string]any); delta["type"] != "text_delta" || delta["text"] != "answer" {
		t.Fatalf("text delta = %#v", delta)
	}
	if events[5].event != "content_block_stop" || int(events[5].data["index"].(float64)) != 1 {
		t.Fatalf("text stop = %#v", events[5])
	}
	assertSSEEvent(t, events[6], "content_block_start", "tool_use", 2)
	toolBlock := events[6].data["content_block"].(map[string]any)
	if toolBlock["id"] != "call_1" || toolBlock["name"] != "lookup" {
		t.Fatalf("tool block = %#v", toolBlock)
	}
	for i, want := range []string{`{"city"`, `:"Paris"}`} {
		delta := events[7+i].data["delta"].(map[string]any)
		if delta["type"] != "input_json_delta" || delta["partial_json"] != want || int(events[7+i].data["index"].(float64)) != 2 {
			t.Fatalf("tool delta %d = %#v", i, events[7+i].data)
		}
	}
	if events[9].event != "content_block_stop" || int(events[9].data["index"].(float64)) != 2 {
		t.Fatalf("tool stop = %#v", events[9])
	}
	delta := events[10].data["delta"].(map[string]any)
	usage := events[10].data["usage"].(map[string]any)
	if events[10].event != "message_delta" || delta["stop_reason"] != "tool_use" || int(usage["input_tokens"].(float64)) != 11 || int(usage["output_tokens"].(float64)) != 5 {
		t.Fatalf("message_delta = %#v", events[10])
	}
	if events[11].event != "message_stop" {
		t.Fatalf("message_stop = %#v", events[11])
	}
}

func TestAnthropicStreamTrackerKeepsKiroReasoningInOneBlock(t *testing.T) {
	recorder := httptest.NewRecorder()
	tracker := &anthropicStreamTracker{writer: recorder, keepThinkingOpen: true}

	tracker.Process(openAIStreamEvent(t, map[string]any{"choices": []any{map[string]any{"delta": map[string]any{"reasoning_content": "\nThe"}}}}))
	tracker.Process(openAIStreamEvent(t, map[string]any{"choices": []any{map[string]any{"delta": map[string]any{"content": "\n\nA cat sat."}}}}))
	tracker.Process(openAIStreamEvent(t, map[string]any{"choices": []any{map[string]any{"delta": map[string]any{"reasoning_content": " user wants a cat poem."}}}}))
	tracker.Process(openAIStreamEvent(t, map[string]any{"choices": []any{map[string]any{"delta": map[string]any{}, "finish_reason": "stop"}}}))
	tracker.Finish()

	events := parseRecordedSSE(t, recorder.Body.String())
	if len(events) != 9 {
		t.Fatalf("events len = %d, want 9: %#v", len(events), events)
	}
	assertSSEEvent(t, events[0], "content_block_start", "thinking", 0)
	if delta := events[1].data["delta"].(map[string]any); delta["type"] != "thinking_delta" || delta["thinking"] != "\nThe" || int(events[1].data["index"].(float64)) != 0 {
		t.Fatalf("first thinking delta = %#v", events[1])
	}
	if delta := events[2].data["delta"].(map[string]any); delta["type"] != "thinking_delta" || delta["thinking"] != " user wants a cat poem." || int(events[2].data["index"].(float64)) != 0 {
		t.Fatalf("late thinking delta = %#v", events[2])
	}
	if events[3].event != "content_block_stop" || int(events[3].data["index"].(float64)) != 0 {
		t.Fatalf("thinking stop = %#v", events[3])
	}
	assertSSEEvent(t, events[4], "content_block_start", "text", 1)
	if delta := events[5].data["delta"].(map[string]any); delta["type"] != "text_delta" || delta["text"] != "\n\nA cat sat." || int(events[5].data["index"].(float64)) != 1 {
		t.Fatalf("text delta = %#v", events[5])
	}
	if events[6].event != "content_block_stop" || int(events[6].data["index"].(float64)) != 1 {
		t.Fatalf("text stop = %#v", events[6])
	}
	if events[7].event != "message_delta" || events[8].event != "message_stop" {
		t.Fatalf("finish events = %#v", events[7:])
	}
}

func TestAnthropicStreamTrackerOnlyDelaysFirstKiroTextChunk(t *testing.T) {
	recorder := httptest.NewRecorder()
	tracker := &anthropicStreamTracker{writer: recorder, keepThinkingOpen: true}

	tracker.Process(openAIStreamEvent(t, map[string]any{"choices": []any{map[string]any{"delta": map[string]any{"reasoning_content": "think"}}}}))
	tracker.Process(openAIStreamEvent(t, map[string]any{"choices": []any{map[string]any{"delta": map[string]any{"content": "answer "}}}}))
	if events := parseRecordedSSE(t, recorder.Body.String()); len(events) != 2 {
		t.Fatalf("events before second text = %d, want 2: %#v", len(events), events)
	}

	tracker.Process(openAIStreamEvent(t, map[string]any{"choices": []any{map[string]any{"delta": map[string]any{"content": "continues"}}}}))
	events := parseRecordedSSE(t, recorder.Body.String())
	if len(events) != 6 {
		t.Fatalf("events after second text = %d, want 6: %#v", len(events), events)
	}
	if events[2].event != "content_block_stop" || int(events[2].data["index"].(float64)) != 0 {
		t.Fatalf("thinking stop = %#v", events[2])
	}
	assertSSEEvent(t, events[3], "content_block_start", "text", 1)
	if delta := events[4].data["delta"].(map[string]any); delta["text"] != "answer " {
		t.Fatalf("first text delta = %#v", events[4])
	}
	if delta := events[5].data["delta"].(map[string]any); delta["text"] != "continues" {
		t.Fatalf("second text delta = %#v", events[5])
	}
}

func TestAnthropicStreamTrackerFinishReasonMappingAndFlush(t *testing.T) {
	tests := []struct {
		finish string
		want   string
	}{
		{finish: "stop", want: "end_turn"},
		{finish: "length", want: "max_tokens"},
		{finish: "function_call", want: "tool_use"},
	}

	for _, tt := range tests {
		t.Run(tt.finish, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			tracker := &anthropicStreamTracker{writer: recorder}
			chunk := openAIStreamEvent(t, map[string]any{"choices": []any{map[string]any{"delta": map[string]any{"content": "ok"}, "finish_reason": tt.finish}}})
			tracker.Process(strings.TrimSuffix(chunk, "\n\n"))
			tracker.Finish()

			events := parseRecordedSSE(t, recorder.Body.String())
			if len(events) != 5 {
				t.Fatalf("events len = %d, want 5: %#v", len(events), events)
			}
			if events[2].event != "content_block_stop" {
				t.Fatalf("content block was not closed before message_delta: %#v", events)
			}
			delta := events[3].data["delta"].(map[string]any)
			if events[3].event != "message_delta" || delta["stop_reason"] != tt.want {
				t.Fatalf("message_delta = %#v, want stop_reason %q", events[3], tt.want)
			}
			if events[4].event != "message_stop" {
				t.Fatalf("message_stop = %#v", events[4])
			}
		})
	}
}

func TestWriteRouteErrorFormats(t *testing.T) {
	param := "model"
	code := "invalid_model"
	retryAfter := "10s"
	retryAfterMS := int64(10000)

	openAIRecorder := httptest.NewRecorder()
	(&Service{}).writeRouteError(openAIRecorder, endpointAdapter{Format: FormatOpenAI}, http.StatusTooManyRequests, "slow down", "rate_limit_error", &param, &code, &retryAfter, &retryAfterMS)
	if openAIRecorder.Code != http.StatusTooManyRequests {
		t.Fatalf("openAI status = %d", openAIRecorder.Code)
	}
	var openAI openAIError
	if err := json.Unmarshal(openAIRecorder.Body.Bytes(), &openAI); err != nil {
		t.Fatalf("decode OpenAI error: %v", err)
	}
	if openAI.Error.Message != "slow down" || openAI.Error.Type != "rate_limit_error" || *openAI.Error.Param != param || *openAI.Error.Code != code || *openAI.Error.RetryAfter != retryAfter || *openAI.Error.RetryAfterMS != retryAfterMS {
		t.Fatalf("OpenAI error = %#v", openAI.Error)
	}

	anthropicRecorder := httptest.NewRecorder()
	(&Service{}).writeRouteError(anthropicRecorder, endpointAdapter{Format: FormatAnthropic}, http.StatusTooManyRequests, "slow down", "rate_limit_error", nil, nil, &retryAfter, &retryAfterMS)
	if anthropicRecorder.Code != http.StatusTooManyRequests {
		t.Fatalf("anthropic status = %d", anthropicRecorder.Code)
	}
	var anthropic map[string]any
	if err := json.Unmarshal(anthropicRecorder.Body.Bytes(), &anthropic); err != nil {
		t.Fatalf("decode Anthropic error: %v", err)
	}
	if anthropic["type"] != "error" {
		t.Fatalf("Anthropic error type = %#v", anthropic)
	}
	inner := anthropic["error"].(map[string]any)
	if inner["type"] != "rate_limit_error" || inner["message"] != "slow down" || inner["retry_after"] != retryAfter || int64(inner["retry_after_ms"].(float64)) != retryAfterMS {
		t.Fatalf("Anthropic inner error = %#v", inner)
	}
}

func TestPassthroughDoesNotCopyProviderHeaders(t *testing.T) {
	writer := &panicHeaderWriter{header: http.Header{}}
	response := &http.Response{
		Header: http.Header{
			"Content-Type":       []string{"application/problem+json"},
			"Retry-After":        []string{"60"},
			"X-Provider-Secret":  []string{"secret"},
			"X-Provider-Account": []string{"upstream"},
		},
		Body: io.NopCloser(strings.NewReader(`{"id":"ok"}`)),
	}

	func() {
		defer func() {
			if recovered := recover(); recovered != errTestWriteHeader {
				t.Fatalf("WriteHeader panic = %v, want sentinel", recovered)
			}
		}()
		_ = (&Service{}).passthroughNonStream(responseContext{Response: response, Writer: writer, AccountID: "acct_1"})
	}()

	if writer.header.Get("Retry-After") != "" || writer.header.Get("X-Provider-Secret") != "" || writer.header.Get("X-Provider-Account") != "" {
		t.Fatalf("provider headers leaked: %#v", writer.header)
	}
	if writer.header.Get("Content-Type") != "application/json" || writer.header.Get("X-Provider-Account-Id") != "acct_1" {
		t.Fatalf("proxy headers missing: %#v", writer.header)
	}
}

func TestValidatePlaygroundAuthAcceptsSignedSession(t *testing.T) {
	timestamp := strconv.FormatInt(time.Now().Unix(), 10)
	request := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
	request.Header.Set(playgroundUserIDHeader, "user_1")
	request.Header.Set(playgroundTimestampHeader, timestamp)
	request.Header.Set(playgroundSignatureHeader, playgroundSignature("secret", "user_1", timestamp, http.MethodPost, "/v1/chat/completions"))

	result, handled := (&Service{secret: "secret"}).validatePlaygroundAuth(request)
	if !handled || !result.Valid || result.UserID != "user_1" || result.APIKeyID != "" || result.ModelAccessMode != "all" || result.AccountAccessMode != "all" {
		t.Fatalf("playground auth result = %#v handled=%v", result, handled)
	}
}

func TestValidatePlaygroundAuthRejectsInvalidSignature(t *testing.T) {
	timestamp := strconv.FormatInt(time.Now().Unix(), 10)
	request := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
	request.Header.Set(playgroundUserIDHeader, "user_1")
	request.Header.Set(playgroundTimestampHeader, timestamp)
	request.Header.Set(playgroundSignatureHeader, "invalid")

	result, handled := (&Service{secret: "secret"}).validatePlaygroundAuth(request)
	if !handled || result.Valid || result.Error == "" {
		t.Fatalf("playground auth result = %#v handled=%v", result, handled)
	}
}

func TestValidatePlaygroundAuthIgnoresMissingPlaygroundHeaders(t *testing.T) {
	request := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)

	result, handled := (&Service{secret: "secret"}).validatePlaygroundAuth(request)
	if handled || result.Valid {
		t.Fatalf("playground auth result = %#v handled=%v", result, handled)
	}
}

func TestValidatePlaygroundAuthRejectsExpiredTimestamp(t *testing.T) {
	timestamp := strconv.FormatInt(time.Now().Add(-playgroundAuthWindow-time.Second).Unix(), 10)
	request := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
	request.Header.Set(playgroundUserIDHeader, "user_1")
	request.Header.Set(playgroundTimestampHeader, timestamp)
	request.Header.Set(playgroundSignatureHeader, playgroundSignature("secret", "user_1", timestamp, http.MethodPost, "/v1/chat/completions"))

	result, handled := (&Service{secret: "secret"}).validatePlaygroundAuth(request)
	if !handled || result.Valid || result.Error == "" {
		t.Fatalf("playground auth result = %#v handled=%v", result, handled)
	}
}

func TestValidateForcedAccountAvailabilityRejectsInactiveForAPIKeys(t *testing.T) {
	param := "model"
	err := validateForcedAccountAvailability(appdb.ProviderAccount{ID: "acct_1", IsActive: false}, false, param)
	if err == nil || err.Code == nil || *err.Code != "provider_account_inactive" {
		t.Fatalf("availability error = %+v, want inactive", err)
	}
}

func TestValidateForcedAccountAvailabilityRejectsTemporarilyDisabledForAPIKeys(t *testing.T) {
	param := "model"
	disabledUntil := time.Now().Add(time.Hour)
	err := validateForcedAccountAvailability(appdb.ProviderAccount{ID: "acct_1", IsActive: true, DisabledUntil: &disabledUntil}, false, param)
	if err == nil || err.Code == nil || *err.Code != "provider_account_temporarily_disabled" {
		t.Fatalf("availability error = %+v, want temporarily disabled", err)
	}
}

func TestValidateForcedAccountAvailabilityAllowsInactiveForPlayground(t *testing.T) {
	param := "model"
	disabledUntil := time.Now().Add(time.Hour)
	err := validateForcedAccountAvailability(appdb.ProviderAccount{ID: "acct_1", IsActive: false, DisabledUntil: &disabledUntil}, true, param)
	if err != nil {
		t.Fatalf("availability error = %+v, want nil", err)
	}
}

func TestValidateSelectedAccountModelRejectsGeminiCLIFreeTierForProModel(t *testing.T) {
	registry, err := models.Load(filepath.Join("..", "..", "..", "..", "models"))
	if err != nil {
		t.Fatal(err)
	}
	service := &Service{registry: registry}
	provider := "gemini_cli"
	freeTier := "free-tier"
	validation := auth.ModelValidationResult{Valid: true, Provider: &provider, Model: "gemini-3.1-pro-preview"}

	routeErr := service.validateSelectedAccountModel(appdb.ProviderAccount{ID: "acct_1", Provider: provider, Tier: &freeTier}, validation, "model")
	if routeErr == nil || routeErr.Code == nil || *routeErr.Code != "provider_account_tier_mismatch" {
		t.Fatalf("route error = %+v, want provider_account_tier_mismatch", routeErr)
	}
}

func TestValidateSelectedAccountModelAllowsGeminiCLIStandardTierForProModel(t *testing.T) {
	registry, err := models.Load(filepath.Join("..", "..", "..", "..", "models"))
	if err != nil {
		t.Fatal(err)
	}
	service := &Service{registry: registry}
	provider := "gemini_cli"
	standardTier := "standard-tier"
	validation := auth.ModelValidationResult{Valid: true, Provider: &provider, Model: "gemini-3.1-pro-preview"}

	if routeErr := service.validateSelectedAccountModel(appdb.ProviderAccount{ID: "acct_1", Provider: provider, Tier: &standardTier}, validation, "model"); routeErr != nil {
		t.Fatalf("route error = %+v, want nil", routeErr)
	}
}

type panicHeaderWriter struct{ header http.Header }

func (w *panicHeaderWriter) Header() http.Header { return w.header }
func (w *panicHeaderWriter) Write([]byte) (int, error) {
	panic("unexpected write")
}
func (w *panicHeaderWriter) WriteHeader(int) { panic(errTestWriteHeader) }

var errTestWriteHeader = struct{}{}

type recordedSSEEvent struct {
	event string
	data  map[string]any
}

func openAIStreamEvent(t *testing.T, payload map[string]any) string {
	t.Helper()
	data, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal stream payload: %v", err)
	}
	return "data: " + string(data) + "\n\n"
}

func parseRecordedSSE(t *testing.T, body string) []recordedSSEEvent {
	t.Helper()
	rawEvents := strings.Split(strings.TrimSpace(body), "\n\n")
	events := make([]recordedSSEEvent, 0, len(rawEvents))
	for _, raw := range rawEvents {
		if raw == "" {
			continue
		}
		var eventName string
		var data string
		for _, line := range strings.Split(raw, "\n") {
			switch {
			case strings.HasPrefix(line, "event: "):
				eventName = strings.TrimPrefix(line, "event: ")
			case strings.HasPrefix(line, "data: "):
				data = strings.TrimPrefix(line, "data: ")
			}
		}
		var parsed map[string]any
		if err := json.Unmarshal([]byte(data), &parsed); err != nil {
			t.Fatalf("decode SSE data %q: %v", data, err)
		}
		events = append(events, recordedSSEEvent{event: eventName, data: parsed})
	}
	return events
}

func assertSSEEvent(t *testing.T, event recordedSSEEvent, eventName, blockType string, index int) {
	t.Helper()
	if event.event != eventName || int(event.data["index"].(float64)) != index {
		t.Fatalf("event = %#v, want %s index %d", event, eventName, index)
	}
	block := event.data["content_block"].(map[string]any)
	if block["type"] != blockType {
		t.Fatalf("content block = %#v, want type %s", block, blockType)
	}
}

func TestPrioritizeAccountsGroupsByProviderAndPaidTier(t *testing.T) {
	paid := "paid"
	accounts := []appdb.ProviderAccount{
		{ID: "free-groq", Provider: "groq"},
		{ID: "paid-groq", Provider: "groq", Tier: &paid},
		{ID: "paid-openrouter", Provider: "openrouter", Tier: &paid},
		{ID: "free-openrouter", Provider: "openrouter"},
	}

	prioritized := prioritizeAccounts(accounts, true, []string{"openrouter", "groq"})
	ids := make([]string, 0, len(prioritized))
	for _, account := range prioritized {
		ids = append(ids, account.ID)
	}
	want := []string{"paid-openrouter", "free-openrouter", "paid-groq", "free-groq"}
	if !reflect.DeepEqual(ids, want) {
		t.Fatalf("prioritized ids = %#v, want %#v", ids, want)
	}
}

func TestAccountAllowedHonorsAccessMode(t *testing.T) {
	tests := []struct {
		name    string
		access  auth.AccountAccess
		wantErr bool
	}{
		{name: "all", access: auth.AccountAccess{Mode: "all"}},
		{name: "whitelist allows", access: auth.AccountAccess{Mode: "whitelist", Accounts: []string{"acct_1", "acct_2"}}},
		{name: "whitelist rejects", access: auth.AccountAccess{Mode: "whitelist", Accounts: []string{"acct_2"}}, wantErr: true},
		{name: "blacklist allows", access: auth.AccountAccess{Mode: "blacklist", Accounts: []string{"acct_2"}}},
		{name: "blacklist rejects", access: auth.AccountAccess{Mode: "blacklist", Accounts: []string{"acct_1"}}, wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := accountAllowed("acct_1", tt.access)
			if (err != nil) != tt.wantErr {
				t.Fatalf("accountAllowed error = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}

func TestAccountAccessDenialCodes(t *testing.T) {
	_, code, denied := accountAccessDenial("acct_1", auth.AccountAccess{Mode: "whitelist", Accounts: []string{"acct_2"}})
	if !denied || code != "provider_account_not_whitelisted" {
		t.Fatalf("whitelist denial = denied %v code %q", denied, code)
	}

	_, code, denied = accountAccessDenial("acct_1", auth.AccountAccess{Mode: "blacklist", Accounts: []string{"acct_1"}})
	if !denied || code != "provider_account_blacklisted" {
		t.Fatalf("blacklist denial = denied %v code %q", denied, code)
	}
}

func TestSyntheticAuthlessAccountAccess(t *testing.T) {
	account, ok := syntheticAuthlessAccount("opencode")
	if !ok || account.ID != "opencode" || account.Provider != "opencode" {
		t.Fatalf("synthetic account = %#v ok %v, want opencode", account, ok)
	}
	if _, ok := syntheticAuthlessAccount("openrouter"); ok {
		t.Fatal("openrouter should not create a synthetic authless account")
	}
	if err := accountAllowed("opencode", auth.AccountAccess{Mode: "whitelist", Accounts: []string{"opencode"}}); err != nil {
		t.Fatalf("opencode whitelist allow error = %v", err)
	}
	if err := accountAllowed("opencode", auth.AccountAccess{Mode: "blacklist", Accounts: []string{"opencode"}}); err == nil {
		t.Fatal("opencode blacklist should reject synthetic account")
	}
}

func TestProviderModelAuthlessSyntheticAccountAccess(t *testing.T) {
	account := syntheticProviderModelAuthlessAccount("kilo_code")
	if account.ID != "authless:kilo_code" || account.Provider != "kilo_code" || !isSyntheticProviderAccountID(account.ID) {
		t.Fatalf("synthetic account = %#v, want authless:kilo_code", account)
	}
	if err := accountAllowed(account.ID, auth.AccountAccess{Mode: "whitelist", Accounts: []string{account.ID}}); err != nil {
		t.Fatalf("authless:kilo_code whitelist allow error = %v", err)
	}
	if err := accountAllowed(account.ID, auth.AccountAccess{Mode: "blacklist", Accounts: []string{account.ID}}); err == nil {
		t.Fatal("authless:kilo_code blacklist should reject synthetic account")
	}
}

func TestBuildAccountErrorMessageIncludesContext(t *testing.T) {
	message := buildAccountErrorMessage("provider failed", accountErrorContext{
		Model:    "test-model",
		Provider: "openrouter",
		Endpoint: "/v1/chat/completions",
		Messages: []any{map[string]any{"role": "user", "content": "hello"}},
		Parameters: map[string]any{
			"stream": true,
			"tools":  []any{map[string]any{"function": map[string]any{"name": "lookup"}}},
		},
	})

	for _, want := range []string{"Error: provider failed", "Provider: openrouter", "Endpoint: /v1/chat/completions", "Model: test-model", "[1 tool(s): lookup]", "Messages (object keys only)"} {
		if !strings.Contains(message, want) {
			t.Fatalf("account error message missing %q:\n%s", want, message)
		}
	}
}

func assertMessage(t *testing.T, raw any, role, content string) {
	t.Helper()
	message, ok := raw.(map[string]any)
	if !ok {
		t.Fatalf("message has type %T, want map[string]any", raw)
	}
	if message["role"] != role || message["content"] != content {
		t.Fatalf("message = %#v, want role %q content %q", message, role, content)
	}
}
