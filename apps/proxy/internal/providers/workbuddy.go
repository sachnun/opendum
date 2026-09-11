package providers

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	appdb "github.com/opendum/opendum/apps/proxy/internal/db"
	"github.com/opendum/opendum/apps/proxy/internal/models"
)

const (
	workbuddyAPIBase          = "https://www.workbuddy.ai"
	workbuddyChatPath         = "/v2/chat/completions"
	workbuddyRefreshPath      = "/v2/plugin/auth/token/refresh"
	workbuddyDomain           = "www.workbuddy.ai"
	workbuddyRefreshSource    = "plugin"
	workbuddyDefaultSystem    = "You are a helpful assistant."
	workbuddyDefaultMaxTokens = 32768
	workbuddyFallbackTTL      = 31536000
)

var supportedWorkbuddy = set("model", "messages", "temperature", "top_p", "max_tokens", "max_completion_tokens", "stream", "stream_options", "tools", "tool_choice", "parallel_tool_calls", "presence_penalty", "frequency_penalty", "n", "stop", "seed", "response_format", "reasoning", "reasoning_effort")

type workbuddyProvider struct {
	registry *models.Registry
}

func (p workbuddyProvider) RefreshCredentials(ctx context.Context, client *http.Client, refreshToken string, _ appdb.ProviderAccount) (RefreshedCredentials, error) {
	payload, _ := json.Marshal(map[string]any{})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, workbuddyAPIBase+workbuddyRefreshPath, bytes.NewReader(payload))
	if err != nil {
		return RefreshedCredentials{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("X-Domain", workbuddyDomain)
	req.Header.Set("X-Refresh-Token", strings.TrimSpace(refreshToken))
	req.Header.Set("X-Auth-Refresh-Source", workbuddyRefreshSource)
	resp, err := client.Do(req)
	if err != nil {
		return RefreshedCredentials{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return RefreshedCredentials{}, fmt.Errorf("workbuddy token refresh failed: %d %s", resp.StatusCode, readLimit(resp.Body, 1<<20))
	}
	var token struct {
		Code int    `json:"code"`
		Msg  string `json:"msg"`
		Data struct {
			AccessToken  string `json:"accessToken"`
			RefreshToken string `json:"refreshToken"`
			ExpiresIn    int64  `json:"expiresIn"`
			ExpiresAt    int64  `json:"expiresAt"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&token); err != nil {
		return RefreshedCredentials{}, err
	}
	if token.Code != 0 || strings.TrimSpace(token.Data.AccessToken) == "" {
		return RefreshedCredentials{}, fmt.Errorf("workbuddy token refresh returned empty token")
	}
	nextRefresh := strings.TrimSpace(token.Data.RefreshToken)
	if nextRefresh == "" {
		nextRefresh = strings.TrimSpace(refreshToken)
	}
	return RefreshedCredentials{AccessToken: strings.TrimSpace(token.Data.AccessToken), RefreshToken: nextRefresh, ExpiresAt: workbuddyExpiry(token.Data.ExpiresAt, token.Data.ExpiresIn)}, nil
}

func (p workbuddyProvider) MakeRequest(ctx context.Context, client *http.Client, accessToken string, account appdb.ProviderAccount, body map[string]any, stream bool) (*http.Response, error) {
	uid := ""
	if account.AccountID != nil {
		uid = strings.TrimSpace(*account.AccountID)
	}
	if uid == "" {
		return nil, fmt.Errorf("workbuddy account is missing user id, re-authenticate this account")
	}
	payload := map[string]any{}
	for key, value := range body {
		if _, ok := supportedWorkbuddy[key]; ok && value != nil {
			payload[key] = value
		}
	}
	model := stringValue(body["model"])
	if strings.HasPrefix(model, "workbuddy/") {
		model = strings.TrimPrefix(model, "workbuddy/")
	}
	modelName := lastModelSegment(model)
	if p.registry != nil {
		modelName = p.registry.UpstreamModelName(modelName, "workbuddy")
	}
	if modelName == "" {
		modelName = model
	}
	messages, _ := body["messages"].([]any)
	payload["messages"] = workbuddyEnsureSystemMessage(messages)
	maxTokens := numberFromAny(body["max_tokens"])
	if maxTokens <= 0 {
		maxTokens = numberFromAny(body["max_completion_tokens"])
	}
	if maxTokens <= 0 {
		maxTokens = workbuddyDefaultMaxTokens
	}
	payload["max_tokens"] = maxTokens
	payload["max_completion_tokens"] = maxTokens
	payload["model"] = modelName
	payload["stream"] = true

	encoded, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, workbuddyAPIBase+workbuddyChatPath, bytes.NewReader(encoded))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(accessToken))
	req.Header.Set("X-User-Id", uid)
	req.Header.Set("X-Domain", workbuddyDomain)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "text/event-stream")
	resp, err := client.Do(req)
	if err != nil || resp == nil || resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return resp, err
	}
	MarkUpstreamResponseStarted(ctx)
	if stream {
		return resp, nil
	}
	completion := workbuddyStreamToCompletion(resp.Body, modelName)
	_ = resp.Body.Close()
	return jsonResponse(http.StatusOK, completion), nil
}

func workbuddyEnsureSystemMessage(messages []any) []any {
	if len(messages) > 0 {
		if first, ok := messages[0].(map[string]any); ok && stringValue(first["role"]) == "system" {
			return messages
		}
	}
	out := make([]any, 0, len(messages)+1)
	out = append(out, map[string]any{"role": "system", "content": workbuddyDefaultSystem})
	return append(out, messages...)
}

func workbuddyExpiry(expiresAt, expiresIn int64) time.Time {
	if expiresAt > 0 {
		if expiresAt > 10_000_000_000 {
			return time.UnixMilli(expiresAt)
		}
		return time.Unix(expiresAt, 0)
	}
	if expiresIn > 0 {
		return time.Now().Add(time.Duration(expiresIn) * time.Second)
	}
	return time.Now().Add(workbuddyFallbackTTL * time.Second)
}

type workbuddyToolCallAcc struct {
	id   string
	typ  string
	name string
	args strings.Builder
}

func workbuddyStreamToCompletion(body io.Reader, model string) map[string]any {
	text, _ := io.ReadAll(body)
	events := parseSSEDataLines(string(text))
	var content strings.Builder
	toolCalls := map[int]*workbuddyToolCallAcc{}
	toolOrder := []int{}
	finishReason := "stop"
	usage := map[string]any{}
	for _, event := range events {
		if next, ok := event["usage"].(map[string]any); ok && len(next) > 0 {
			usage = next
		}
		choices, _ := event["choices"].([]any)
		if len(choices) == 0 {
			continue
		}
		choice, _ := choices[0].(map[string]any)
		if choice == nil {
			continue
		}
		if reason := stringValue(choice["finish_reason"]); reason != "" {
			finishReason = reason
		}
		delta, _ := choice["delta"].(map[string]any)
		if delta == nil {
			continue
		}
		content.WriteString(workbuddyDeltaText(delta["content"]))
		if reasoning, ok := delta["reasoning_content"].(string); ok {
			content.WriteString(reasoning)
		}
		if fragments, ok := delta["tool_calls"].([]any); ok {
			for _, raw := range fragments {
				fragment, _ := raw.(map[string]any)
				if fragment == nil {
					continue
				}
				index := numberFromAny(fragment["index"])
				acc, ok := toolCalls[index]
				if !ok {
					acc = &workbuddyToolCallAcc{}
					toolCalls[index] = acc
					toolOrder = append(toolOrder, index)
				}
				if id := stringValue(fragment["id"]); id != "" {
					acc.id = id
				}
				if typ := stringValue(fragment["type"]); typ != "" {
					acc.typ = typ
				}
				if fn, ok := fragment["function"].(map[string]any); ok {
					if name := stringValue(fn["name"]); name != "" {
						acc.name += name
					}
					if args, ok := fn["arguments"].(string); ok {
						acc.args.WriteString(args)
					}
				}
			}
		}
	}
	message := map[string]any{"role": "assistant", "content": content.String()}
	if len(toolOrder) > 0 {
		calls := make([]any, 0, len(toolOrder))
		for _, index := range toolOrder {
			acc := toolCalls[index]
			typ := acc.typ
			if typ == "" {
				typ = "function"
			}
			id := acc.id
			if id == "" {
				id = fmt.Sprintf("call_%d", index)
			}
			calls = append(calls, map[string]any{"id": id, "type": typ, "function": map[string]any{"name": acc.name, "arguments": acc.args.String()}})
		}
		message["tool_calls"] = calls
		if finishReason == "stop" {
			finishReason = "tool_calls"
		}
	}
	return map[string]any{
		"id":      "chatcmpl-workbuddy",
		"object":  "chat.completion",
		"created": time.Now().Unix(),
		"model":   model,
		"choices": []any{map[string]any{"index": 0, "message": message, "finish_reason": finishReason}},
		"usage":   usage,
	}
}

func workbuddyDeltaText(value any) string {
	switch content := value.(type) {
	case string:
		return content
	case []any:
		var b strings.Builder
		for _, part := range content {
			if m, ok := part.(map[string]any); ok {
				if t, ok := m["text"].(string); ok {
					b.WriteString(t)
					continue
				}
				if t, ok := m["content"].(string); ok {
					b.WriteString(t)
				}
			}
		}
		return b.String()
	}
	return ""
}
