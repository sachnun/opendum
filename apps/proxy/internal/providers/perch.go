package providers

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	appdb "github.com/opendum/opendum/apps/proxy/internal/db"
	"github.com/opendum/opendum/apps/proxy/internal/models"
)

const (
	perchAppURL           = "https://app.perchai.app"
	perchAuthConfigPath   = "/api/perch-terminal/cli-auth/config"
	perchAccountPath      = "/api/perchai/account"
	perchModelCallPath    = "/api/perch-terminal/model-call"
	perchAccessTTL        = time.Hour
	perchRefreshBuffer    = 5 * time.Minute
	perchConfigCacheTTL   = 15 * time.Minute
	perchSessionCacheTTL  = 10 * time.Minute
	perchFallbackAlias    = "qwen-3.6"
	perchModelCallTimeout = 5 * time.Second
)

// Perch Starter model pool (free tier, see
// https://www.perchai.app/docs/concepts/models) reversed from the perchai-cli
// bundle (v2.4.98): perch alias -> manualModelOptionId. Only Starter-pool pins
// resolve on a free account; every premium entry is Pro-only and is rejected
// by the server, so it is intentionally not mapped. MiniMax M2.7/M3 free
// variants are a promotion and may leave the Starter pool.
var perchManualOptionIDs = map[string]string{
	"minimax-m3-free":   "gmi-minimaxai-minimax-m3",
	"minimax-m2.7-free": "openrouter-minimax-minimax-m2-7-free",
	"qwen-3.6":          "wandb-qwen3-6-35b-a3b",
	"kimi-2.5":          "bedrock-mantle-moonshotai-kimi-k2-5",
	"glm-5":             "bedrock-mantle-zai-glm-5",
	"qwen3-coder":       "bedrock-mantle-qwen-qwen3-coder-480b-a35b-instruct",
	"nemotron-super":    "bedrock-mantle-nvidia-nemotron-super-3-120b",
	"gemma-4-e2b":       "bedrock-mantle-google-gemma-4-e2b",
	"gemma-4-31b":       "bedrock-mantle-google-gemma-4-31b",
}

type perchAuthConfig struct {
	supabaseURL string
	anonKey     string
}

var perchAuthConfigState struct {
	mu        sync.Mutex
	config    *perchAuthConfig
	fetchedAt time.Time
}

// fetchPerchAuthConfig returns the Supabase project URL and anon key the Perch
// CLI uses for OAuth. Values are public (embedded in the CLI) and cached.
func fetchPerchAuthConfig(ctx context.Context, client *http.Client) (*perchAuthConfig, error) {
	perchAuthConfigState.mu.Lock()
	defer perchAuthConfigState.mu.Unlock()
	if cached := perchAuthConfigState.config; cached != nil && time.Since(perchAuthConfigState.fetchedAt) < perchConfigCacheTTL {
		return cached, nil
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, perchAppURL+perchAuthConfigPath, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("perch auth config request failed: %d", resp.StatusCode)
	}
	var payload struct {
		SupabaseURL  string `json:"supabaseUrl"`
		SupabaseAnon string `json:"supabaseAnonKey"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return nil, err
	}
	supabaseURL := strings.TrimSpace(payload.SupabaseURL)
	anonKey := strings.TrimSpace(payload.SupabaseAnon)
	if supabaseURL == "" || anonKey == "" {
		return nil, fmt.Errorf("perch auth config is incomplete")
	}
	config := &perchAuthConfig{supabaseURL: strings.TrimRight(supabaseURL, "/"), anonKey: anonKey}
	perchAuthConfigState.config = config
	perchAuthConfigState.fetchedAt = time.Now()
	return config, nil
}

func perchRefreshPayload(refreshToken string) ([]byte, error) {
	return json.Marshal(map[string]string{"refresh_token": strings.TrimSpace(refreshToken)})
}

func perchTokenHeaders(config *perchAuthConfig) map[string]string {
	return map[string]string{
		"Content-Type":  "application/json",
		"apikey":        config.anonKey,
		"Authorization": "Bearer " + config.anonKey,
	}
}

type perchProvider struct {
	registry *models.Registry
}

func (p perchProvider) RefreshBuffer() time.Duration { return perchRefreshBuffer }

// RefreshCredentials exchanges a Supabase refresh token for a fresh Perch
// session, exactly like the CLI's auth refresh.
func (p perchProvider) RefreshCredentials(ctx context.Context, client *http.Client, refreshToken string, _ appdb.ProviderAccount) (RefreshedCredentials, error) {
	config, err := fetchPerchAuthConfig(ctx, client)
	if err != nil {
		return RefreshedCredentials{}, err
	}
	body, err := perchRefreshPayload(refreshToken)
	if err != nil {
		return RefreshedCredentials{}, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, config.supabaseURL+"/auth/v1/token?grant_type=refresh_token", bytes.NewReader(body))
	if err != nil {
		return RefreshedCredentials{}, err
	}
	for key, value := range perchTokenHeaders(config) {
		req.Header.Set(key, value)
	}
	req.Header.Set("Accept", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return RefreshedCredentials{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return RefreshedCredentials{}, fmt.Errorf("perch token refresh failed: %d %s", resp.StatusCode, readLimit(resp.Body, 1<<20))
	}
	var token struct {
		AccessToken  string  `json:"access_token"`
		RefreshToken string  `json:"refresh_token"`
		ExpiresAt    float64 `json:"expires_at"`
		ExpiresIn    float64 `json:"expires_in"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&token); err != nil {
		return RefreshedCredentials{}, err
	}
	if strings.TrimSpace(token.AccessToken) == "" {
		return RefreshedCredentials{}, fmt.Errorf("perch token refresh returned empty access token")
	}
	expiresAt := time.Now().Add(perchAccessTTL)
	if token.ExpiresAt > 0 {
		expiresAt = time.UnixMilli(int64(token.ExpiresAt * 1000))
	} else if token.ExpiresIn > 0 {
		expiresAt = time.Now().Add(time.Duration(token.ExpiresIn) * time.Second)
	}
	nextRefresh := strings.TrimSpace(token.RefreshToken)
	if nextRefresh == "" {
		nextRefresh = strings.TrimSpace(refreshToken)
	}
	return RefreshedCredentials{AccessToken: strings.TrimSpace(token.AccessToken), RefreshToken: nextRefresh, ExpiresAt: expiresAt}, nil
}

type perchSessionIDs struct {
	userID      string
	workspaceID string
}

var perchSessionState = struct {
	mu      sync.Mutex
	entries map[string]perchSessionEntry
}{entries: map[string]perchSessionEntry{}}

type perchSessionEntry struct {
	ids       perchSessionIDs
	fetchedAt time.Time
}

// sessionIDsForAccount mirrors the CLI's vy(): userId/workspaceId from the
// account endpoint, cached per account. Attribution stays nil when unknown.
func sessionIDsForAccount(ctx context.Context, client *http.Client, account appdb.ProviderAccount, accessToken string) *perchSessionIDs {
	if account.ID == "" {
		return nil
	}
	perchSessionState.mu.Lock()
	if cached, ok := perchSessionState.entries[account.ID]; ok && time.Since(cached.fetchedAt) < perchSessionCacheTTL {
		perchSessionState.mu.Unlock()
		return &cached.ids
	}
	perchSessionState.mu.Unlock()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, perchAppURL+perchAccountPath, nil)
	if err != nil {
		return nil
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(accessToken))
	timeoutCtx, cancel := context.WithTimeout(ctx, perchModelCallTimeout)
	defer cancel()
	resp, err := client.Do(req.WithContext(timeoutCtx))
	if err != nil {
		return nil
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil
	}
	var payload struct {
		OK      bool `json:"ok"`
		Session struct {
			UserID      string `json:"userId"`
			WorkspaceID string `json:"workspaceId"`
		} `json:"session"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil || !payload.OK {
		return nil
	}
	ids := perchSessionIDs{userID: payload.Session.UserID, workspaceID: payload.Session.WorkspaceID}
	perchSessionState.mu.Lock()
	perchSessionState.entries[account.ID] = perchSessionEntry{ids: ids, fetchedAt: time.Now()}
	perchSessionState.mu.Unlock()
	return &ids
}

func perchModelOptionID(alias string) string {
	if option, ok := perchManualOptionIDs[alias]; ok {
		return option
	}
	return perchManualOptionIDs[perchFallbackAlias]
}

func perchRunID() string {
	buf := make([]byte, 4)
	_, _ = rand.Read(buf)
	return fmt.Sprintf("cli-turn-%d-%s", time.Now().UnixMilli(), hex.EncodeToString(buf))
}

func perchMessages(body map[string]any) []any {
	var out []any
	if system := strings.TrimSpace(perchTextFromContent(body["system"])); system != "" {
		out = append(out, map[string]any{"role": "system", "content": system})
	}
	rawMessages, _ := body["messages"].([]any)
	for _, rawMessage := range rawMessages {
		message, _ := rawMessage.(map[string]any)
		if message == nil {
			continue
		}
		role := stringValue(message["role"])
		switch role {
		case "system", "developer":
			if text := strings.TrimSpace(perchTextFromContent(message["content"])); text != "" {
				out = append(out, map[string]any{"role": "system", "content": text})
			}
		case "user":
			out = append(out, map[string]any{"role": "user", "content": perchTextFromContent(message["content"])})
		case "assistant":
			text := perchTextFromContent(message["content"])
			entry := map[string]any{"role": "assistant", "content": text}
			if calls, ok := message["tool_calls"].([]any); ok && len(calls) > 0 {
				converted := []any{}
				for _, rawCall := range calls {
					call, _ := rawCall.(map[string]any)
					if call == nil {
						continue
					}
					fn, _ := call["function"].(map[string]any)
					arguments := "{}"
					if fn != nil {
						if args := stringValue(fn["arguments"]); args != "" {
							arguments = args
						}
					}
					converted = append(converted, map[string]any{
						"id":   stringValue(call["id"]),
						"type": "function",
						"function": map[string]any{
							"name":      stringValue(fn["name"]),
							"arguments": arguments,
						},
					})
				}
				entry["tool_calls"] = converted
			}
			out = append(out, entry)
		case "tool":
			out = append(out, map[string]any{
				"role":         "tool",
				"tool_call_id": stringValue(message["tool_call_id"]),
				"content":      perchTextFromContent(message["content"]),
			})
		}
	}
	return out
}

// perchTextFromContent flattens OpenAI content (string or part array) to text,
// dropping image parts the Perch chat lane cannot carry.
func perchTextFromContent(value any) string {
	switch typed := value.(type) {
	case string:
		return typed
	case []any:
		parts := []string{}
		for _, part := range typed {
			if partMap, ok := part.(map[string]any); ok {
				if stringValue(partMap["type"]) == "text" {
					if text := stringValue(partMap["text"]); text != "" {
						parts = append(parts, text)
					}
				}
			}
		}
		return strings.Join(parts, "\n")
	default:
		return ""
	}
}

func perchTools(body map[string]any) []any {
	rawTools, _ := body["tools"].([]any)
	if len(rawTools) == 0 {
		return nil
	}
	out := []any{}
	for _, rawTool := range rawTools {
		tool, _ := rawTool.(map[string]any)
		if tool == nil {
			continue
		}
		fn, _ := tool["function"].(map[string]any)
		if fn == nil {
			continue
		}
		name := stringValue(fn["name"])
		if name == "" {
			continue
		}
		parameters := fn["parameters"]
		if parameters == nil {
			parameters = map[string]any{"type": "object", "properties": map[string]any{}}
		}
		converted := map[string]any{"type": "function", "function": map[string]any{"name": name, "parameters": parameters}}
		if description := stringValue(fn["description"]); description != "" {
			converted["function"].(map[string]any)["description"] = description
		}
		out = append(out, converted)
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// perchEffortFromBody maps an OpenAI reasoning_effort into the CLI's effort
// state. Defaults to the CLI's persisted state (high/on).
func perchEffortFromBody(body map[string]any) (level string, reasoningEnabled bool) {
	level = "high"
	reasoningEnabled = true
	if raw, ok := body["reasoning_effort"].(string); ok {
		switch strings.ToLower(strings.TrimSpace(raw)) {
		case "off", "none":
			level = "off"
			reasoningEnabled = false
		case "low", "medium":
			level = strings.ToLower(strings.TrimSpace(raw))
		case "high", "xhigh", "max":
			level = "high"
		}
	}
	return level, reasoningEnabled
}

func (p perchProvider) MakeRequest(ctx context.Context, client *http.Client, credentials string, account appdb.ProviderAccount, body map[string]any, stream bool) (*http.Response, error) {
	requestedModel := stringValue(body["model"])
	upstream := perchModelAlias(p.registry, requestedModel)
	includeReasoning := isTruthful(body["_includeReasoning"])

	runID := perchRunID()
	attribution := any(nil)
	if ids := sessionIDsForAccount(ctx, client, account, credentials); ids != nil && ids.userID != "" && ids.workspaceID != "" {
		attribution = map[string]any{
			"userId":            ids.userID,
			"workspaceId":       ids.workspaceID,
			"runId":             runID,
			"lane":              "chat",
			"source":            "cli",
			"billingMultiplier": nil,
		}
	}

	request := map[string]any{
		"lane":     "chat",
		"messages": perchMessages(body),
	}
	tools := perchTools(body)
	if len(tools) > 0 {
		request["tools"] = tools
		request["toolChoice"] = "auto"
	}
	if temperature := body["temperature"]; temperature != nil {
		request["temperature"] = temperature
	}
	if maxTokens := firstNonNilAny(body["max_tokens"], body["max_completion_tokens"]); maxTokens != nil {
		request["maxOutputTokens"] = maxTokens
	}

	effortLevel, reasoningEnabled := perchEffortFromBody(body)
	payload := map[string]any{
		"request":             request,
		"runId":               runID,
		"lane":                "chat",
		"strictManual":        false,
		"preferredModelId":    nil,
		"avoidModelIds":       []any{},
		"attribution":         attribution,
		"clientSurface":       "cli",
		"manualModelOptionId": perchModelOptionID(upstream),
		"roostModelChoice":    "standard",
		"roostReasoning":      reasoningEnabled,
		"effort":              map[string]any{"level": effortLevel, "orchestration": false},
	}

	rawBody, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, perchAppURL+perchModelCallPath, bytes.NewReader(rawBody))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(credentials))
	req.Header.Set("Accept", "text/event-stream")

	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	MarkUpstreamResponseStarted(ctx)

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return resp, nil
	}

	if stream {
		return sseResponse(perchSSEToChatSSEReader(resp.Body, requestedModel, includeReasoning), resp.Body), nil
	}
	completion, err := perchSSEToChatCompletion(resp.Body, requestedModel, includeReasoning)
	_ = resp.Body.Close()
	if err != nil {
		return nil, err
	}
	return jsonResponse(http.StatusOK, completion), nil
}

func perchModelAlias(registry *models.Registry, model string) string {
	model = strings.TrimSpace(model)
	if strings.HasPrefix(model, "perch/") {
		model = strings.TrimPrefix(model, "perch/")
	}
	if registry != nil {
		model = registry.UpstreamModelName(model, "perch")
	}
	if model == "" {
		return perchFallbackAlias
	}
	return model
}

func firstNonNilAny(values ...any) any {
	for _, value := range values {
		if value != nil {
			return value
		}
	}
	return nil
}
