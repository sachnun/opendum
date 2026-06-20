package providers

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	appdb "github.com/opendum/opendum/apps/proxy/internal/db"
	"github.com/opendum/opendum/apps/proxy/internal/models"
)

const (
	commandCodeBaseURL   = "https://api.commandcode.ai"
	commandCodeGenerate  = "/alpha/generate"
	commandCodeVersion   = "0.38.7"
	commandCodeEnv       = "production"
	commandCodeProject   = "command-code"
	commandCodePlatform  = "linux-x64"
	commandCodeMaxTokens = 16384
)

type commandCodeProvider struct {
	registry *models.Registry
}

func (p commandCodeProvider) MakeRequest(ctx context.Context, client *http.Client, credentials string, _ appdb.ProviderAccount, body map[string]any, stream bool) (*http.Response, error) {
	model := stringValue(body["model"])
	if strings.HasPrefix(model, "command_code/") {
		model = strings.TrimPrefix(model, "command_code/")
	}
	if p.registry != nil {
		model = p.registry.UpstreamModelName(model, "command_code")
	}

	includeReasoning := isTruthful(body["_includeReasoning"])
	envelope := buildCommandCodeEnvelope(body, model)

	reqBody, err := json.Marshal(envelope)
	if err != nil {
		return nil, err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, commandCodeBaseURL+commandCodeGenerate, strings.NewReader(string(reqBody)))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(credentials))
	req.Header.Set("Accept", "text/event-stream")
	req.Header.Set("x-command-code-version", commandCodeVersion)
	req.Header.Set("x-cli-environment", commandCodeEnv)
	req.Header.Set("x-project-slug", commandCodeProject)

	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	MarkUpstreamResponseStarted(ctx)

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return resp, nil
	}

	if stream {
		return sseResponse(commandCodeSSEToChatSSEReader(resp.Body, model, includeReasoning), resp.Body), nil
	}

	// Upstream always streams; for non-stream requests, buffer the SSE stream
	// and synthesize a single chat.completion JSON object.
	completion, err := commandCodeSSEToChatCompletion(resp.Body, model, includeReasoning)
	_ = resp.Body.Close()
	if err != nil {
		return nil, err
	}
	return jsonResponse(http.StatusOK, completion), nil
}

func isTruthful(value any) bool {
	b, ok := value.(bool)
	return ok && b
}

// buildCommandCodeEnvelope mirrors the reverse-engineered Command Code CLI
// payload (see sachnun/command-opencode): a wrapper carrying a spoofed runtime
// "config" plus the OpenAI-style "params" (with system extracted out and CC
// tool/message shapes).
func buildCommandCodeEnvelope(body map[string]any, model string) map[string]any {
	system, messages := commandCodeMessages(body["messages"])
	tools := commandCodeTools(body["tools"])

	maxTokens := numberFromAny(body["max_tokens"])
	if maxTokens == 0 {
		maxTokens = numberFromAny(body["max_completion_tokens"])
	}
	if maxTokens == 0 {
		maxTokens = commandCodeMaxTokens
	}

	params := map[string]any{
		"model":      model,
		"messages":   messages,
		"stream":     true,
		"max_tokens": maxTokens,
	}
	if len(tools) > 0 {
		params["tools"] = tools
	}
	if system != "" {
		params["system"] = system
	}
	if value := body["temperature"]; value != nil {
		params["temperature"] = value
	}
	if value := body["top_p"]; value != nil {
		params["top_p"] = value
	}

	return map[string]any{
		"config": map[string]any{
			"workingDir":    "/",
			"date":          time.Now().UTC().Format("2006-01-02"),
			"environment":   commandCodePlatform,
			"structure":     []any{},
			"isGitRepo":     false,
			"currentBranch": "",
			"mainBranch":    "",
			"gitStatus":     "",
			"recentCommits": []any{},
		},
		"memory":         "",
		"taste":          "",
		"skills":         nil,
		"permissionMode": "standard",
		"params":         params,
	}
}

// commandCodeMessages converts OpenAI chat messages into the CLI's message
// shape: system messages are flattened into a single `system` string, user
// content collapses to text, assistant turns become typed content parts, and
// tool results map to tool-result parts (resolving tool names via prior
// assistant tool_calls).
func commandCodeMessages(raw any) (string, []any) {
	source, _ := raw.([]any)
	if source == nil {
		return "", []any{}
	}

	toolNamesByID := map[string]string{}
	for _, item := range source {
		msg, ok := item.(map[string]any)
		if !ok {
			continue
		}
		if calls, ok := msg["tool_calls"].([]any); ok {
			for _, rawCall := range calls {
				call, _ := rawCall.(map[string]any)
				fn, _ := call["function"].(map[string]any)
				name := stringValue(fn["name"])
				id := stringValue(call["id"])
				if name != "" && id != "" {
					toolNamesByID[id] = name
				}
			}
		}
	}

	systemParts := []string{}
	out := make([]any, 0, len(source))

	for _, item := range source {
		msg, ok := item.(map[string]any)
		if !ok {
			continue
		}
		role := stringValue(msg["role"])
		switch role {
		case "system", "developer":
			if text := strings.TrimSpace(contentToText(msg["content"])); text != "" {
				systemParts = append(systemParts, text)
			}
		case "user":
			out = append(out, map[string]any{"role": "user", "content": contentToText(msg["content"])})
		case "assistant":
			out = append(out, map[string]any{"role": "assistant", "content": commandCodeAssistantParts(msg)})
		case "tool":
			id := stringValue(msg["tool_call_id"])
			out = append(out, map[string]any{
				"role": "tool",
				"content": []any{map[string]any{
					"type":       "tool-result",
					"toolCallId": id,
					"toolName":   toolNamesByID[id],
					"output":     map[string]any{"type": "text", "value": contentToText(msg["content"])},
				}},
			})
		default:
			out = append(out, map[string]any{"role": defaultEmpty(role, "user"), "content": contentToText(msg["content"])})
		}
	}

	return strings.Join(systemParts, "\n\n"), out
}

func commandCodeAssistantParts(msg map[string]any) []any {
	parts := []any{}
	if text := contentToText(msg["content"]); text != "" {
		parts = append(parts, map[string]any{"type": "text", "text": text})
	}
	if calls, ok := msg["tool_calls"].([]any); ok {
		for _, rawCall := range calls {
			call, _ := rawCall.(map[string]any)
			fn, _ := call["function"].(map[string]any)
			name := stringValue(fn["name"])
			if name == "" {
				continue
			}
			parts = append(parts, map[string]any{
				"type":       "tool-call",
				"toolCallId": stringValue(call["id"]),
				"toolName":   name,
				"input":      defaultStringValue(fn["arguments"], "{}"),
			})
		}
	}
	return parts
}

// commandCodeTools converts OpenAI function tools to the CLI shape
// ({type:"function", name, description, input_schema}).
func commandCodeTools(raw any) []any {
	tools, _ := raw.([]any)
	out := make([]any, 0, len(tools))
	for _, item := range tools {
		tool, _ := item.(map[string]any)
		fn, _ := tool["function"].(map[string]any)
		if fn == nil {
			fn = tool
		}
		name := stringValue(fn["name"])
		if name == "" {
			name = stringValue(tool["name"])
		}
		if name == "" {
			continue
		}
		params, _ := fn["parameters"].(map[string]any)
		if params == nil {
			params = map[string]any{"type": "object", "properties": map[string]any{}}
		}
		entry := map[string]any{"type": "function", "name": name, "description": defaultStringValue(fn["description"], ""), "input_schema": params}
		if strict, ok := fn["strict"].(bool); ok {
			entry["strict"] = strict
		}
		out = append(out, entry)
	}
	return out
}
