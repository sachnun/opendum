package providers

import (
	"bufio"
	"bytes"
	"context"
	crand "crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"

	appdb "github.com/opendum/opendum/apps/proxy/internal/db"
	"github.com/opendum/opendum/apps/proxy/internal/models"
)

const googleOAuthTokenEndpoint = "https://oauth2.googleapis.com/token"
const antigravitySignatureCachePrefix = "opendum:thought-signature"
const antigravitySignatureCacheTTL = 24 * time.Hour
const antigravityClaudeBetaHeader = "interleaved-thinking-2025-05-14"
const antigravityAuthUserAgent = "google-api-nodejs-client/10.3.0"
const antigravityAuthAPIClient = "gl-node/22.18.0"
const antigravityAuthClientMetadata = `{"ideType":"IDE_UNSPECIFIED","platform":"PLATFORM_UNSPECIFIED","pluginType":"GEMINI"}`
const geminiToolSchemaSystemInstruction = `<CRITICAL_TOOL_USAGE_INSTRUCTIONS>
You are operating in a CUSTOM ENVIRONMENT where tool definitions COMPLETELY DIFFER from your training data.
VIOLATION OF THESE RULES WILL CAUSE IMMEDIATE SYSTEM FAILURE.

## ABSOLUTE RULES - NO EXCEPTIONS

1. **SCHEMA IS LAW**: The JSON schema in each tool definition is the ONLY source of truth.
2. **PARAMETER NAMES ARE EXACT**: Use ONLY the parameter names from the schema.
3. **ARRAY PARAMETERS**: When a parameter has "type": "array", check the 'items' field.
4. **NESTED OBJECTS**: When items.type is "object", include exact required nested fields.
5. **STRICT PARAMETERS HINT**: Tool descriptions contain "STRICT PARAMETERS: ...".
6. **BEFORE EVERY TOOL CALL**: Read tool schema and verify exact required params.
</CRITICAL_TOOL_USAGE_INSTRUCTIONS>

## GEMINI 3 RESPONSE RULES
- Default to a direct, concise answer; add detail only when asked or required for correctness.
- For multi-part tasks, use a short numbered list or labeled sections.
- For long provided context, answer only from that context and avoid assumptions.
- For multimodal inputs, explicitly reference each modality used and synthesize across them; do not invent details from absent modalities.
- For complex tasks, outline a short plan and verify constraints before acting.
`

type googleCodeAssistProvider struct {
	name             string
	clientID         string
	clientSecret     string
	endpoint         string
	endpoints        []string
	loadEndpoints    []string
	onboardEndpoints []string
	refreshBuffer    time.Duration
	defaultProject   string
	userAgent        string
	apiClient        string
	clientMetadata   string
	registry         *models.Registry
	db               *appdb.DB
	redis            *redis.Client
}

type geminiCLIProvider struct {
	registry *models.Registry
	db       *appdb.DB
	redis    *redis.Client
}
type antigravityProvider struct {
	registry *models.Registry
	db       *appdb.DB
	redis    *redis.Client
}

func (p geminiCLIProvider) delegate() googleCodeAssistProvider {
	return googleCodeAssistProvider{name: "gemini_cli", clientID: "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com", clientSecret: "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", endpoint: "https://daily-cloudcode-pa.sandbox.googleapis.com", endpoints: []string{"https://daily-cloudcode-pa.sandbox.googleapis.com", "https://cloudcode-pa.googleapis.com"}, loadEndpoints: []string{"https://cloudcode-pa.googleapis.com", "https://daily-cloudcode-pa.sandbox.googleapis.com"}, onboardEndpoints: []string{"https://daily-cloudcode-pa.sandbox.googleapis.com", "https://cloudcode-pa.googleapis.com"}, refreshBuffer: 30 * time.Minute, userAgent: "GeminiCLI/0.34.0 (win32; x64)", registry: p.registry, db: p.db, redis: p.redis}
}

func (p antigravityProvider) delegate() googleCodeAssistProvider {
	platform := runtime.GOOS + "/" + runtime.GOARCH
	return googleCodeAssistProvider{name: "antigravity", clientID: "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com", clientSecret: "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", endpoint: "https://daily-cloudcode-pa.googleapis.com", endpoints: []string{"https://daily-cloudcode-pa.googleapis.com", "https://autopush-cloudcode-pa.sandbox.googleapis.com", "https://cloudcode-pa.googleapis.com"}, loadEndpoints: []string{"https://cloudcode-pa.googleapis.com", "https://daily-cloudcode-pa.googleapis.com"}, onboardEndpoints: []string{"https://daily-cloudcode-pa.googleapis.com", "https://cloudcode-pa.googleapis.com"}, refreshBuffer: time.Hour, defaultProject: "rising-fact-p41fc", userAgent: "antigravity/1.23.2 " + platform, apiClient: "google-cloud-sdk vscode_cloudshelleditor/0.1", clientMetadata: `{"ideType":"IDE_UNSPECIFIED","platform":"PLATFORM_UNSPECIFIED","pluginType":"GEMINI"}`, registry: p.registry, db: p.db, redis: p.redis}
}

func (p geminiCLIProvider) RefreshBuffer() time.Duration   { return p.delegate().RefreshBuffer() }
func (p antigravityProvider) RefreshBuffer() time.Duration { return p.delegate().RefreshBuffer() }
func (p geminiCLIProvider) RefreshCredentials(ctx context.Context, client *http.Client, refreshToken string, account appdb.ProviderAccount) (RefreshedCredentials, error) {
	return p.delegate().RefreshCredentials(ctx, client, refreshToken, account)
}
func (p antigravityProvider) RefreshCredentials(ctx context.Context, client *http.Client, refreshToken string, account appdb.ProviderAccount) (RefreshedCredentials, error) {
	return p.delegate().RefreshCredentials(ctx, client, refreshToken, account)
}
func (p geminiCLIProvider) MakeRequest(ctx context.Context, client *http.Client, credentials string, account appdb.ProviderAccount, body map[string]any, stream bool) (*http.Response, error) {
	return p.delegate().MakeRequest(ctx, client, credentials, account, body, stream)
}
func (p antigravityProvider) MakeRequest(ctx context.Context, client *http.Client, credentials string, account appdb.ProviderAccount, body map[string]any, stream bool) (*http.Response, error) {
	return p.delegate().MakeRequest(ctx, client, credentials, account, body, stream)
}

func (p googleCodeAssistProvider) RefreshBuffer() time.Duration { return p.refreshBuffer }

func (p googleCodeAssistProvider) RefreshCredentials(ctx context.Context, client *http.Client, refreshToken string, _ appdb.ProviderAccount) (RefreshedCredentials, error) {
	form := url.Values{}
	form.Set("client_id", p.clientID)
	form.Set("client_secret", p.clientSecret)
	form.Set("refresh_token", strings.TrimSpace(refreshToken))
	form.Set("grant_type", "refresh_token")
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, googleOAuthTokenEndpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return RefreshedCredentials{}, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := client.Do(req)
	if err != nil {
		return RefreshedCredentials{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body := readLimit(resp.Body, 1<<20)
		return RefreshedCredentials{}, fmt.Errorf("%s token refresh failed: %d %s", p.name, resp.StatusCode, body)
	}
	var token struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		ExpiresIn    int64  `json:"expires_in"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&token); err != nil {
		return RefreshedCredentials{}, err
	}
	if token.AccessToken == "" {
		return RefreshedCredentials{}, fmt.Errorf("%s token refresh returned empty access token", p.name)
	}
	if token.RefreshToken == "" {
		token.RefreshToken = refreshToken
	}
	if token.ExpiresIn <= 0 {
		token.ExpiresIn = 3600
	}
	info := p.fetchAccountInfo(ctx, client, token.AccessToken)
	return RefreshedCredentials{AccessToken: token.AccessToken, RefreshToken: token.RefreshToken, ExpiresAt: time.Now().Add(time.Duration(token.ExpiresIn) * time.Second), ProjectID: info.projectID, Tier: info.tier, Email: info.email}, nil
}

func (p googleCodeAssistProvider) MakeRequest(ctx context.Context, client *http.Client, accessToken string, account appdb.ProviderAccount, body map[string]any, stream bool) (*http.Response, error) {
	projectID := ""
	if account.ProjectID != nil {
		projectID = strings.TrimSpace(*account.ProjectID)
	}
	if p.name == "antigravity" && projectID == "" {
		projectID = p.defaultProject
	}
	if projectID == "" {
		info := p.fetchAccountInfo(ctx, client, accessToken)
		projectID = info.projectID
		if projectID == "" {
			projectID = p.defaultProject
		}
		if projectID != "" && p.db != nil {
			_, _ = p.db.NewUpdate().Model((*appdb.ProviderAccount)(nil)).Set("\"projectId\" = ?", projectID).Set("tier = ?", info.tier).Set("email = ?", info.email).Where("id = ?", account.ID).Exec(ctx)
		}
	}
	if projectID == "" {
		return nil, fmt.Errorf("%s account missing projectId", p.name)
	}
	modelName := p.resolveModel(stringValue(body["model"]))
	if p.name == "antigravity" {
		modelName = p.resolveAntigravityGemini3ModelVariant(modelName, body)
	}
	body = p.normalizeBodyForModel(body, modelName)
	if messages, ok := body["messages"].([]any); ok && (p.name != "antigravity" || strings.Contains(modelName, "claude")) {
		body["messages"] = convertImageURLsToBase64(ctx, client, messages)
	}
	sessionID := randomUUID()
	geminiPayload := openAIToGemini(body)
	if p.name == "antigravity" {
		p.transformAntigravityPayload(ctx, geminiPayload, modelName, sessionID)
	} else {
		p.applyThinkingConfig(geminiPayload, modelName, stringValue(body["reasoning_effort"]), numberFromAny(body["thinking_budget"]))
	}
	toolSchemas := buildToolSchemaMap(geminiPayload["tools"])
	if p.name == "antigravity" && !isImageGenerationModel(p.registry, modelName) && !providerConfigBool(p.registry, modelName, p.name, "strict_tool_schema") {
		sanitizeToolSchemaKeys(toolSchemas)
	}
	requestPayload := p.wrapCodeAssistPayload(projectID, modelName, geminiPayload)
	actualStream := stream
	if p.name == "antigravity" && !strings.Contains(modelName, "gemini") && !stream {
		actualStream = true
	} else if providerConfigBool(p.registry, modelName, p.name, "force_stream_non_stream") && !stream {
		actualStream = true
	}
	action := "generateContent"
	if actualStream {
		action = "streamGenerateContent?alt=sse"
	}
	encoded, err := json.Marshal(requestPayload)
	if err != nil {
		return nil, err
	}
	var lastResp *http.Response
	var lastErr error
	for _, endpoint := range p.endpointsOrDefault() {
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint+"/v1internal:"+action, bytes.NewReader(encoded))
		if err != nil {
			return nil, err
		}
		p.setGoogleGenerationHeaders(req, accessToken, actualStream)
		if p.name == "antigravity" && p.shouldSetAnthropicBeta(modelName) {
			req.Header.Set("anthropic-beta", antigravityClaudeBetaHeader)
		}
		resp, err := client.Do(req)
		if err != nil {
			lastErr = err
			continue
		}
		if resp.StatusCode == http.StatusTooManyRequests {
			MarkUpstreamResponseStarted(ctx)
			return resp, nil
		}
		if resp.StatusCode >= 500 || resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden || resp.StatusCode == http.StatusNotFound {
			data, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
			_ = resp.Body.Close()
			resp.Body = io.NopCloser(bytes.NewReader(data))
			lastResp = resp
			continue
		}
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			MarkUpstreamResponseStarted(ctx)
			return resp, nil
		}
		MarkUpstreamResponseStarted(ctx)
		lastResp = resp
		lastErr = nil
		break
	}
	resp := lastResp
	if p.name == "antigravity" && resp != nil && resp.StatusCode == http.StatusNotFound && isImageGenerationModel(p.registry, modelName) {
		data := readLimit(resp.Body, 1<<20)
		_ = resp.Body.Close()
		return nil, fmt.Errorf("model %q returned 404 (NOT_FOUND) from all Code Assist endpoints. This image generation model requires a paid Google account (Google AI Pro/Ultra or Gemini Code Assist subscription). Free-tier accounts do not have access to image generation models. Original error: %s", modelName, data)
	}
	if lastErr != nil || resp == nil || resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return resp, lastErr
	}
	if stream {
		return sseResponse(p.geminiSSEToOpenAISSEReader(ctx, resp.Body, modelName, sessionID, toolSchemas), resp.Body), nil
	}
	if actualStream {
		completion := p.geminiStreamToOpenAICompletion(ctx, resp.Body, modelName, sessionID, toolSchemas)
		_ = resp.Body.Close()
		return jsonResponse(http.StatusOK, completion), nil
	}
	var data any
	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		_ = resp.Body.Close()
		return nil, err
	}
	_ = resp.Body.Close()
	response := unwrapGeminiResponse(data)
	p.cacheSignaturesFromResponse(ctx, response, modelName, sessionID)
	return jsonResponse(http.StatusOK, geminiToOpenAICompletion(response, modelName, toolSchemas)), nil
}

func (p googleCodeAssistProvider) wrapCodeAssistPayload(projectID, model string, geminiPayload map[string]any) map[string]any {
	if p.name != "antigravity" {
		return map[string]any{"model": model, "project": projectID, "user_prompt_id": randomID("prompt"), "request": geminiPayload}
	}
	return map[string]any{"project": projectID, "model": model, "userAgent": "antigravity", "requestType": "agent", "requestId": randomHyphenID("agent"), "request": geminiPayload}
}

func (p googleCodeAssistProvider) shouldSetAnthropicBeta(model string) bool {
	return strings.Contains(model, "claude") && strings.Contains(model, "thinking")
}

func isOpusThinkingModel(model string) bool {
	return strings.HasPrefix(model, "claude-opus-") && strings.HasSuffix(model, "-thinking")
}

func randomHyphenID(prefix string) string {
	return prefix + "-" + randomUUID()
}

func randomUUID() string {
	buf := make([]byte, 16)
	if _, err := crand.Read(buf); err != nil {
		return strings.TrimPrefix(randomID("uuid"), "uuid_")
	}
	buf[6] = (buf[6] & 0x0f) | 0x40
	buf[8] = (buf[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", buf[0:4], buf[4:6], buf[6:8], buf[8:10], buf[10:16])
}

func isAntigravityProjectContextError(text string) bool {
	lower := strings.ToLower(text)
	return strings.Contains(lower, "#3501") ||
		(strings.Contains(lower, "google cloud project") && strings.Contains(lower, "code assist license")) ||
		strings.Contains(lower, "invalid project resource name projects/") ||
		(strings.Contains(lower, "resource projects/") && strings.Contains(lower, "could not be found")) ||
		(strings.Contains(lower, "project") && strings.Contains(lower, "not found"))
}

func (p googleCodeAssistProvider) transformAntigravityPayload(ctx context.Context, payload map[string]any, model, sessionID string) {
	delete(payload, "safetySettings")
	if systemInstruction := payload["system_instruction"]; systemInstruction != nil {
		payload["systemInstruction"] = systemInstruction
		delete(payload, "system_instruction")
	}
	p.normalizeCachedContent(payload)
	delete(payload, "model")
	if isImageGenerationModel(p.registry, model) {
		delete(payload, "tools")
		delete(payload, "toolConfig")
		if generation, ok := payload["generationConfig"].(map[string]any); ok {
			delete(generation, "thinkingConfig")
		}
	} else {
		ensureToolConfig(payload)
		p.normalizeThinkingConfig(payload, model)
		if providerConfigBool(p.registry, model, p.name, "strict_tool_schema") {
			normalizeClaudeTools(payload)
		} else {
			sanitizeGeminiToolNames(payload)
			augmentToolDescriptions(payload)
			injectGeminiToolInstruction(payload)
		}
	}
	p.applyAntigravitySystemInstruction(payload, model)
	p.normalizeAntigravityContents(ctx, payload, model, sessionID)
	if model == "claude-sonnet-4-6" {
		if generation, ok := payload["generationConfig"].(map[string]any); ok {
			delete(generation, "thinkingConfig")
		}
	}
	payload["sessionId"] = sessionID
}

func (p googleCodeAssistProvider) normalizeCachedContent(payload map[string]any) {
	if extra, ok := payload["extra_body"].(map[string]any); ok {
		if value := defaultStringValue(extra["cached_content"], stringValue(extra["cachedContent"])); value != "" {
			payload["cachedContent"] = value
		}
		delete(extra, "cached_content")
		delete(extra, "cachedContent")
		if len(extra) == 0 {
			delete(payload, "extra_body")
		}
	}
	if value := defaultStringValue(payload["cached_content"], stringValue(payload["cachedContent"])); value != "" {
		payload["cachedContent"] = value
	}
	delete(payload, "cached_content")
	delete(payload, "cachedContent")
}

func (p googleCodeAssistProvider) normalizeThinkingConfig(payload map[string]any, model string) {
	generation, _ := payload["generationConfig"].(map[string]any)
	if generation == nil {
		if providerConfigBool(p.registry, model, p.name, "thinking_model") {
			generation = map[string]any{}
			payload["generationConfig"] = generation
		} else {
			return
		}
	}
	rawThinking, _ := generation["thinkingConfig"].(map[string]any)
	if isGemini3ModelName(model) {
		if thinking := p.normalizeGemini3ThinkingConfig(rawThinking, model); thinking != nil {
			generation["thinkingConfig"] = thinking
			p.ensureGemini3MaxOutputTokens(generation, model, stringValue(thinking["thinkingLevel"]))
		} else {
			delete(generation, "thinkingConfig")
		}
		return
	}
	thinking := normalizedThinkingMap(rawThinking)
	if providerConfigBool(p.registry, model, p.name, "thinking_model") {
		if thinking == nil {
			thinking = map[string]any{"thinkingBudget": 16384, "include_thoughts": true}
		}
		if thinking["include_thoughts"] == nil && thinking["includeThoughts"] == nil {
			thinking["include_thoughts"] = true
		}
		if thinking["thinkingBudget"] == nil && thinking["thinking_budget"] == nil {
			thinking["thinkingBudget"] = 16384
		}
		finalThinking := thinking
		if providerConfigBool(p.registry, model, p.name, "strict_tool_schema") {
			finalThinking = map[string]any{"include_thoughts": defaultBool(thinking["include_thoughts"], defaultBool(thinking["includeThoughts"], true))}
			if budget := numberFromAny(defaultAny(thinking["thinkingBudget"], thinking["thinking_budget"])); budget > 0 {
				finalThinking["thinking_budget"] = budget
			}
		}
		generation["thinkingConfig"] = finalThinking
		budget := numberFromAny(defaultAny(thinking["thinkingBudget"], thinking["thinking_budget"]))
		if budget > 0 {
			if maxTokens := numberFromAny(defaultAny(generation["maxOutputTokens"], generation["max_output_tokens"])); maxTokens == 0 || maxTokens <= budget {
				generation["maxOutputTokens"] = 64000
				delete(generation, "max_output_tokens")
			}
		}
		return
	}
	if thinking != nil {
		generation["thinkingConfig"] = thinking
	} else {
		delete(generation, "thinkingConfig")
	}
}

func normalizedThinkingMap(value any) map[string]any {
	record, ok := value.(map[string]any)
	if !ok || record == nil {
		return nil
	}
	out := map[string]any{}
	if budget := numberFromAny(defaultAny(record["thinkingBudget"], record["thinking_budget"])); budget > 0 {
		out["thinkingBudget"] = budget
	}
	if level := defaultStringValue(record["thinkingLevel"], stringValue(record["thinking_level"])); level != "" {
		out["thinkingLevel"] = strings.ToLower(level)
	}
	if include, ok := defaultAny(record["includeThoughts"], record["include_thoughts"]).(bool); ok {
		out["include_thoughts"] = include
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func defaultAny(value, fallback any) any {
	if value != nil {
		return value
	}
	return fallback
}

func defaultBool(value any, fallback bool) bool {
	if boolValue, ok := value.(bool); ok {
		return boolValue
	}
	return fallback
}

func (p googleCodeAssistProvider) resolveModel(model string) string {
	model = strings.TrimSuffix(lastModelSegment(model), ":thinking")
	if p.registry != nil {
		model = p.registry.UpstreamModelName(model, p.name)
	}
	return model
}

func (p googleCodeAssistProvider) resolveAntigravityGemini3ModelVariant(model string, body map[string]any) string {
	if !isGemini3ModelName(model) || !strings.Contains(strings.ToLower(model), "pro") {
		return model
	}
	base := strings.TrimSuffix(strings.TrimSuffix(strings.TrimSuffix(model, "-low"), "-medium"), "-high")
	level := geminiThinkingLevelFromModel(model)
	if bodyLevel := p.requestedGemini3ThinkingLevel(model, body); bodyLevel != "" {
		level = bodyLevel
	}
	if level == "" {
		level = "high"
	}
	return base + "-" + level
}

func (p googleCodeAssistProvider) requestedGemini3ThinkingLevel(model string, body map[string]any) string {
	if thinking, ok := body["thinking"].(map[string]any); ok {
		if level := p.normalizeGemini3ThinkingLevel(model, stringValue(thinking["thinkingLevel"])); level != "" {
			return level
		}
		if budget := numberFromAny(thinking["budget_tokens"]); budget > 0 {
			return p.thinkingLevelFromBudget(model, budget)
		}
	}
	if budget := numberFromAny(body["thinking_budget"]); budget > 0 {
		return p.thinkingLevelFromBudget(model, budget)
	}
	if level := p.thinkingLevelFromEffort(model, stringValue(body["reasoning_effort"])); level != "" {
		return level
	}
	if reasoning, ok := body["reasoning"].(map[string]any); ok {
		if level := p.thinkingLevelFromEffort(model, stringValue(reasoning["effort"])); level != "" {
			return level
		}
	}
	return ""
}

func (p googleCodeAssistProvider) normalizeBodyForModel(body map[string]any, model string) map[string]any {
	out := cloneAnyMap(body)
	delete(out, "logit_bias")
	if providerConfigBool(p.registry, model, p.name, "top_p_min_095") {
		if topP, ok := numberAsFloat(out["top_p"]); ok && topP < 0.95 {
			delete(out, "top_p")
		}
	}
	if isImageGenerationModel(p.registry, model) {
		for _, key := range []string{"reasoning", "reasoning_effort", "thinking_budget", "include_thoughts", "presence_penalty", "frequency_penalty", "tools", "tool_choice", "_includeReasoning"} {
			delete(out, key)
		}
	}
	return out
}

func (p googleCodeAssistProvider) endpointsOrDefault() []string {
	if len(p.endpoints) > 0 {
		return p.endpoints
	}
	return []string{p.endpoint}
}

func numberAsFloat(value any) (float64, bool) {
	switch v := value.(type) {
	case float64:
		return v, true
	case int:
		return float64(v), true
	case int64:
		return float64(v), true
	default:
		return 0, false
	}
}

func anySlice(value any) []any {
	items, _ := value.([]any)
	return items
}

func mapSlice(value any) []map[string]any {
	items, _ := value.([]any)
	out := make([]map[string]any, 0, len(items))
	for _, raw := range items {
		item, _ := raw.(map[string]any)
		if item != nil {
			out = append(out, item)
		}
	}
	return out
}

func stableSessionID(body map[string]any) string {
	messages, _ := body["messages"].([]any)
	for _, raw := range messages {
		msg, _ := raw.(map[string]any)
		if stringValue(msg["role"]) != "user" {
			continue
		}
		text := contentToText(msg["content"])
		if strings.TrimSpace(text) == "" {
			continue
		}
		sum := sha256.Sum256([]byte(text))
		hexValue := hex.EncodeToString(sum[:16])
		return fmt.Sprintf("%s-%s-%s-%s-%s", hexValue[:8], hexValue[8:12], hexValue[12:16], hexValue[16:20], hexValue[20:32])
	}
	return randomID("session")
}

func (p googleCodeAssistProvider) signatureFamily(model string) string {
	if family := providerConfigString(p.registry, model, p.name, "signature_family"); family != "" {
		return family
	}
	return providerConfigString(p.registry, model, p.name, "transform")
}

func (p googleCodeAssistProvider) signatureCacheKey(model, sessionID, thoughtText string) string {
	normalized := strings.TrimSpace(thoughtText)
	sum := sha256.Sum256([]byte(p.signatureFamily(model) + ":" + sessionID + ":" + normalized))
	return antigravitySignatureCachePrefix + ":" + hex.EncodeToString(sum[:])
}

func (p googleCodeAssistProvider) getCachedSignature(ctx context.Context, model, sessionID, thoughtText string) string {
	if p.redis == nil || sessionID == "" || strings.TrimSpace(thoughtText) == "" {
		return ""
	}
	data, err := p.redis.Get(ctx, p.signatureCacheKey(model, sessionID, thoughtText)).Bytes()
	if err != nil {
		return ""
	}
	var cached map[string]any
	if err := json.Unmarshal(data, &cached); err != nil {
		return ""
	}
	return stringValue(cached["signature"])
}

func (p googleCodeAssistProvider) cacheSignature(ctx context.Context, model, sessionID, thoughtText, signature string) {
	if p.redis == nil || sessionID == "" || strings.TrimSpace(thoughtText) == "" || strings.TrimSpace(signature) == "" {
		return
	}
	data, err := json.Marshal(map[string]any{"signature": signature})
	if err != nil {
		return
	}
	_ = p.redis.Set(ctx, p.signatureCacheKey(model, sessionID, thoughtText), data, antigravitySignatureCacheTTL).Err()
}

func ensureToolConfig(payload map[string]any) {
	toolConfig, _ := payload["toolConfig"].(map[string]any)
	if toolConfig == nil {
		toolConfig = map[string]any{}
		payload["toolConfig"] = toolConfig
	}
	calling, _ := toolConfig["functionCallingConfig"].(map[string]any)
	if calling == nil {
		calling = map[string]any{}
		toolConfig["functionCallingConfig"] = calling
	}
	calling["mode"] = "VALIDATED"
}

func normalizeClaudeTools(payload map[string]any) {
	tools, _ := payload["tools"].([]any)
	for _, rawTool := range tools {
		tool, _ := rawTool.(map[string]any)
		decls, _ := tool["functionDeclarations"].([]any)
		for _, rawDecl := range decls {
			decl, _ := rawDecl.(map[string]any)
			if schema := decl["parametersJsonSchema"]; schema != nil {
				decl["parameters"] = schema
				delete(decl, "parametersJsonSchema")
			}
			params, _ := decl["parameters"].(map[string]any)
			if params == nil {
				params = map[string]any{"type": "object", "properties": map[string]any{}}
			}
			params = sanitizeGoogleFunctionSchema(params)
			if params["type"] == nil {
				params["type"] = "object"
			}
			if params["properties"] == nil {
				params["properties"] = map[string]any{}
			}
			decl["parameters"] = params
		}
	}
}

func sanitizeGeminiToolNames(payload map[string]any) {
	tools, _ := payload["tools"].([]any)
	for _, rawTool := range tools {
		tool, _ := rawTool.(map[string]any)
		decls, _ := tool["functionDeclarations"].([]any)
		for _, rawDecl := range decls {
			decl, _ := rawDecl.(map[string]any)
			decl["name"] = sanitizedToolName(stringValue(decl["name"]))
		}
	}
}

func augmentToolDescriptions(payload map[string]any) {
	tools, _ := payload["tools"].([]any)
	for _, rawTool := range tools {
		tool, _ := rawTool.(map[string]any)
		decls, _ := tool["functionDeclarations"].([]any)
		for _, rawDecl := range decls {
			decl, _ := rawDecl.(map[string]any)
			description := stringValue(decl["description"])
			if strings.Contains(description, "STRICT PARAMETERS:") {
				continue
			}
			params, _ := decl["parameters"].(map[string]any)
			if params == nil {
				params, _ = decl["parametersJsonSchema"].(map[string]any)
			}
			if params == nil {
				continue
			}
			summary := strictParamsSummary(params)
			if summary == "" {
				continue
			}
			if description != "" {
				decl["description"] = strings.TrimSpace(description) + "\n\nSTRICT PARAMETERS: " + summary
			} else {
				decl["description"] = "STRICT PARAMETERS: " + summary
			}
		}
	}
}

func injectGeminiToolInstruction(payload map[string]any) {
	if !hasFunctionTools(payload) {
		return
	}
	if strings.Contains(systemInstructionText(payload["systemInstruction"]), "<CRITICAL_TOOL_USAGE_INSTRUCTIONS>") {
		return
	}
	existing := payload["systemInstruction"]
	if text, ok := existing.(string); ok {
		if strings.TrimSpace(text) != "" {
			payload["systemInstruction"] = map[string]any{"parts": []any{map[string]any{"text": geminiToolSchemaSystemInstruction + "\n\n" + text}}}
		} else {
			payload["systemInstruction"] = map[string]any{"parts": []any{map[string]any{"text": geminiToolSchemaSystemInstruction}}}
		}
		return
	}
	if record, ok := existing.(map[string]any); ok {
		parts := []any{map[string]any{"text": geminiToolSchemaSystemInstruction}}
		parts = append(parts, anySlice(record["parts"])...)
		record["parts"] = parts
		payload["systemInstruction"] = record
		return
	}
	payload["systemInstruction"] = map[string]any{"parts": []any{map[string]any{"text": geminiToolSchemaSystemInstruction}}}
}

func hasFunctionTools(payload map[string]any) bool {
	for _, rawTool := range anySlice(payload["tools"]) {
		tool, _ := rawTool.(map[string]any)
		if len(anySlice(tool["functionDeclarations"])) > 0 {
			return true
		}
	}
	return false
}

func systemInstructionText(value any) string {
	if text, ok := value.(string); ok {
		return text
	}
	record, _ := value.(map[string]any)
	parts := []string{}
	for _, rawPart := range anySlice(record["parts"]) {
		part, _ := rawPart.(map[string]any)
		if text := stringValue(part["text"]); text != "" {
			parts = append(parts, text)
		}
	}
	return strings.Join(parts, "\n")
}

func strictParamsSummary(schema map[string]any) string {
	props, _ := schema["properties"].(map[string]any)
	if stringValue(schema["type"]) != "object" || len(props) == 0 {
		return "(schema missing top-level object properties)"
	}
	required := map[string]struct{}{}
	for _, raw := range anySlice(schema["required"]) {
		if key := stringValue(raw); key != "" {
			required[key] = struct{}{}
		}
	}
	requiredKeys := []string{}
	optionalKeys := []string{}
	for key := range props {
		if _, ok := required[key]; ok {
			requiredKeys = append(requiredKeys, key)
		} else {
			optionalKeys = append(optionalKeys, key)
		}
	}
	sort.Strings(requiredKeys)
	sort.Strings(optionalKeys)
	ordered := append(requiredKeys, optionalKeys...)
	parts := []string{}
	for _, key := range ordered {
		rawProp := props[key]
		prop, _ := rawProp.(map[string]any)
		typ := summarizeSchema(prop, 2)
		if _, ok := required[key]; ok {
			typ += " REQUIRED"
		}
		parts = append(parts, key+": "+typ)
	}
	summary := strings.Join(parts, ", ")
	if len(summary) > 900 {
		return summary[:900] + "..."
	}
	return summary
}

func summarizeSchema(schema map[string]any, depth int) string {
	if schema == nil {
		return "unknown"
	}
	typ := normalizeSchemaType(schema["type"])
	if typ == "" {
		typ = "unknown"
	}
	if typ == "array" {
		items, _ := schema["items"].(map[string]any)
		itemSummary := "unknown"
		if depth > 0 {
			itemSummary = summarizeSchema(items, depth-1)
		}
		return "array[" + itemSummary + "]"
	}
	if typ == "object" {
		props, _ := schema["properties"].(map[string]any)
		if len(props) == 0 || depth <= 0 {
			return "object"
		}
		required := map[string]bool{}
		for _, raw := range anySlice(schema["required"]) {
			if key := stringValue(raw); key != "" {
				required[key] = true
			}
		}
		keys := make([]string, 0, len(props))
		for key := range props {
			keys = append(keys, key)
		}
		sort.SliceStable(keys, func(i, j int) bool {
			if required[keys[i]] != required[keys[j]] {
				return required[keys[i]]
			}
			return keys[i] < keys[j]
		})
		shown := keys
		if len(shown) > 8 {
			shown = shown[:8]
		}
		parts := []string{}
		for _, key := range shown {
			prop, _ := props[key].(map[string]any)
			text := key + ": " + summarizeSchema(prop, depth-1)
			if required[key] {
				text += " REQUIRED"
			}
			parts = append(parts, text)
		}
		extra := ""
		if len(keys) > len(shown) {
			extra = fmt.Sprintf(", ...+%d", len(keys)-len(shown))
		}
		return "{" + strings.Join(parts, ", ") + extra + "}"
	}
	if enumValues := anySlice(schema["enum"]); len(enumValues) > 0 {
		preview := []string{}
		for idx, value := range enumValues {
			if idx >= 6 {
				break
			}
			preview = append(preview, fmt.Sprint(value))
		}
		suffix := ""
		if len(enumValues) > 6 {
			suffix = "|..."
		}
		return typ + " enum(" + strings.Join(preview, "|") + suffix + ")"
	}
	return typ
}

func normalizeSchemaType(value any) string {
	if text := stringValue(value); text != "" {
		return text
	}
	for _, raw := range anySlice(value) {
		text := stringValue(raw)
		if text != "" && text != "null" {
			return text
		}
	}
	if values := anySlice(value); len(values) > 0 {
		return stringValue(values[0])
	}
	return ""
}

func (p googleCodeAssistProvider) normalizeAntigravityContents(ctx context.Context, payload map[string]any, model, sessionID string) {
	contents, _ := payload["contents"].([]any)
	strictToolSchema := providerConfigBool(p.registry, model, p.name, "strict_tool_schema")
	functionCallIDQueues := map[string][]string{}
	for _, rawContent := range contents {
		content, _ := rawContent.(map[string]any)
		if providerConfigBool(p.registry, model, p.name, "scrub_model_artifacts") && content["role"] == "model" {
			scrubConversationArtifacts(content)
		}
		parts, _ := content["parts"].([]any)
		filtered := []any{}
		currentThoughtSignature := ""
		for _, rawPart := range parts {
			part, _ := rawPart.(map[string]any)
			if text, ok := part["text"].(string); ok && text == "" {
				continue
			}
			if part["thought"] == true {
				thoughtText := stringValue(part["text"])
				signature := stringValue(part["thoughtSignature"])
				if strictToolSchema {
					if signature == "" || len(signature) < 50 {
						if cached := p.getCachedSignature(ctx, model, sessionID, thoughtText); cached != "" {
							signature = cached
							part["thoughtSignature"] = cached
						}
					}
					if len(signature) > 50 {
						p.cacheSignature(ctx, model, sessionID, thoughtText, signature)
						currentThoughtSignature = signature
					} else {
						continue
					}
				} else {
					if cached := p.getCachedSignature(ctx, model, sessionID, thoughtText); cached != "" {
						part["thoughtSignature"] = cached
						currentThoughtSignature = cached
						filtered = append(filtered, rawPart)
					}
					continue
				}
			}
			if part["functionCall"] != nil {
				fn, _ := part["functionCall"].(map[string]any)
				name := stringValue(fn["name"])
				if fn["id"] == nil {
					fn["id"] = randomID(name)
				}
				if strictToolSchema && name != "" {
					functionCallIDQueues[name] = append(functionCallIDQueues[name], stringValue(fn["id"]))
				}
				if !strictToolSchema && providerConfigBool(p.registry, model, p.name, "inject_thought_signature") && part["thoughtSignature"] == nil {
					if currentThoughtSignature != "" {
						part["thoughtSignature"] = currentThoughtSignature
					} else {
						part["thoughtSignature"] = "skip_thought_signature_validator"
					}
				}
			}
			if part["functionResponse"] != nil {
				fn, _ := part["functionResponse"].(map[string]any)
				if fn["id"] == nil {
					name := stringValue(fn["name"])
					if strictToolSchema && len(functionCallIDQueues[name]) > 0 {
						fn["id"] = functionCallIDQueues[name][0]
						functionCallIDQueues[name] = functionCallIDQueues[name][1:]
					} else {
						fn["id"] = randomID(name)
					}
				}
			}
			if !strictToolSchema && part["thoughtSignature"] != nil && part["functionCall"] == nil {
				delete(part, "thoughtSignature")
			}
			filtered = append(filtered, rawPart)
		}
		content["parts"] = filtered
	}
	if strictToolSchema || providerConfigBool(p.registry, model, p.name, "sanitize_tool_blocks") {
		payload["contents"] = sanitizeToolBlocks(contents)
	}
}

var toolArtifactMarker = regexp.MustCompile(`(?i)^\s*(Tool:\s*\w+|(?:thought|think)\s*:)`)

func scrubConversationArtifacts(content map[string]any) {
	parts := anySlice(content["parts"])
	for _, rawPart := range parts {
		part, _ := rawPart.(map[string]any)
		text := stringValue(part["text"])
		if text == "" {
			continue
		}
		part["text"] = scrubToolTranscriptArtifacts(text)
	}
}

func scrubToolTranscriptArtifacts(text string) string {
	lines := strings.Split(text, "\n")
	output := []string{}
	inFence := false
	fenceStart := ""
	fenceLines := []string{}
	flushFence := func(end string) {
		cleaned := []string{}
		hadMarker := false
		for _, line := range fenceLines {
			if toolArtifactMarker.MatchString(line) {
				hadMarker = true
				continue
			}
			cleaned = append(cleaned, line)
		}
		hasContent := false
		for _, line := range cleaned {
			if strings.TrimSpace(line) != "" {
				hasContent = true
				break
			}
		}
		if !hadMarker || hasContent {
			output = append(output, fenceStart)
			output = append(output, cleaned...)
			output = append(output, end)
		}
	}
	for _, line := range lines {
		if strings.HasPrefix(strings.TrimSpace(line), "```") {
			if !inFence {
				inFence = true
				fenceStart = line
				fenceLines = []string{}
				continue
			}
			flushFence(line)
			inFence = false
			continue
		}
		if inFence {
			fenceLines = append(fenceLines, line)
			continue
		}
		if toolArtifactMarker.MatchString(line) {
			continue
		}
		output = append(output, line)
	}
	if inFence {
		output = append(output, fenceStart)
		output = append(output, fenceLines...)
	}
	cleaned := strings.Join(output, "\n")
	for strings.Contains(cleaned, "\n\n\n\n") {
		cleaned = strings.ReplaceAll(cleaned, "\n\n\n\n", "\n\n\n")
	}
	return cleaned
}

func sanitizeToolBlocks(contents []any) []any {
	callIDs := map[string]struct{}{}
	responseIDs := map[string]struct{}{}
	for _, rawContent := range contents {
		content, _ := rawContent.(map[string]any)
		for _, rawPart := range anySlice(content["parts"]) {
			part, _ := rawPart.(map[string]any)
			if fn, ok := part["functionCall"].(map[string]any); ok {
				if id := stringValue(fn["id"]); id != "" {
					callIDs[id] = struct{}{}
				}
			}
			if fn, ok := part["functionResponse"].(map[string]any); ok {
				if id := stringValue(fn["id"]); id != "" {
					responseIDs[id] = struct{}{}
				}
			}
		}
	}
	out := []any{}
	for _, rawContent := range contents {
		content, _ := rawContent.(map[string]any)
		parts := []any{}
		for _, rawPart := range anySlice(content["parts"]) {
			part, _ := rawPart.(map[string]any)
			if fn, ok := part["functionCall"].(map[string]any); ok {
				if _, exists := responseIDs[stringValue(fn["id"])]; !exists {
					continue
				}
			}
			if fn, ok := part["functionResponse"].(map[string]any); ok {
				if _, exists := callIDs[stringValue(fn["id"])]; !exists {
					continue
				}
			}
			parts = append(parts, rawPart)
		}
		if len(parts) > 0 {
			copyContent := cloneAnyMap(content)
			copyContent["parts"] = parts
			out = append(out, copyContent)
		}
	}
	return out
}

type googleCodeAssistAccountInfo struct {
	projectID string
	tier      string
	email     string
}

func (p googleCodeAssistProvider) fetchAccountInfo(ctx context.Context, client *http.Client, accessToken string) googleCodeAssistAccountInfo {
	info := googleCodeAssistAccountInfo{tier: "free-tier"}
	loadEndpoints := p.loadEndpoints
	if len(loadEndpoints) == 0 {
		loadEndpoints = []string{"https://cloudcode-pa.googleapis.com", p.endpoint}
	}
	currentTierPresent := false
	allowedTiers := []map[string]any{}
	hadError := false
	for _, endpoint := range loadEndpoints {
		metadata := codeAssistMetadata()
		payload, _ := json.Marshal(map[string]any{"metadata": metadata})
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint+"/v1internal:loadCodeAssist", bytes.NewReader(payload))
		if err != nil {
			hadError = true
			continue
		}
		p.setGoogleHeaders(req, accessToken, false)
		resp, err := client.Do(req)
		if err != nil || resp == nil {
			hadError = true
			continue
		}
		var data map[string]any
		if resp.StatusCode >= 200 && resp.StatusCode < 300 {
			_ = json.NewDecoder(resp.Body).Decode(&data)
		} else {
			hadError = true
		}
		_ = resp.Body.Close()
		if len(data) == 0 {
			continue
		}
		if project := extractGoogleProjectID(data); project != "" {
			info.projectID = project
		}
		if currentTier := data["currentTier"]; currentTier != nil {
			currentTierPresent = true
		}
		currentTierID := extractGoogleTier(data)
		if currentTierID != "" {
			info.tier = currentTierID
		}
		if tiers := extractAllowedTiers(data); len(tiers) > 0 {
			allowedTiers = tiers
		}
		if currentTierID == "" {
			if tier := detectAntigravityTier(data); tier != "" {
				info.tier = tier
			}
		}
		if info.projectID != "" {
			break
		}
	}
	if info.projectID == "" && !currentTierPresent {
		if onboard := p.onboardUser(ctx, client, accessToken, info.tier, allowedTiers); onboard.projectID != "" {
			info.projectID = onboard.projectID
			info.tier = onboard.tier
		}
	}
	if p.name == "antigravity" && info.projectID == "" && hadError {
		info.projectID = p.defaultProject
	}
	info.email = p.fetchGoogleEmail(ctx, client, accessToken)
	return info
}

func (p googleCodeAssistProvider) onboardUser(ctx context.Context, client *http.Client, accessToken, tier string, allowedTiers []map[string]any) googleCodeAssistAccountInfo {
	if p.name == "antigravity" && len(allowedTiers) == 0 {
		return googleCodeAssistAccountInfo{}
	}
	onboardTier := selectOnboardTier(tier, allowedTiers)
	if onboardTier == "" {
		return googleCodeAssistAccountInfo{}
	}
	onboardEndpoints := p.onboardEndpoints
	if len(onboardEndpoints) == 0 {
		onboardEndpoints = []string{p.endpoint, "https://cloudcode-pa.googleapis.com"}
	}
	onboardRequest := map[string]any{"tierId": onboardTier, "metadata": codeAssistMetadata()}
	payload, _ := json.Marshal(onboardRequest)
	for _, endpoint := range onboardEndpoints {
		data, ok := p.postOnboardUser(ctx, client, accessToken, endpoint, payload)
		if !ok {
			continue
		}
		for i := 0; i < 30 && data["done"] == false; i++ {
			if !sleepContext(ctx, 2*time.Second) {
				return googleCodeAssistAccountInfo{}
			}
			polled, pollOK := p.postOnboardUser(ctx, client, accessToken, endpoint, payload)
			if pollOK {
				data = polled
			}
		}
		if done, ok := data["done"].(bool); ok && !done {
			continue
		}
		if response, ok := data["response"].(map[string]any); ok {
			data = response
		}
		if project := extractGoogleProjectID(data); project != "" {
			return googleCodeAssistAccountInfo{projectID: project, tier: normalizeGoogleTierID(onboardTier)}
		}
	}
	return googleCodeAssistAccountInfo{}
}

func (p googleCodeAssistProvider) postOnboardUser(ctx context.Context, client *http.Client, accessToken, endpoint string, payload []byte) (map[string]any, bool) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint+"/v1internal:onboardUser", bytes.NewReader(payload))
	if err != nil {
		return nil, false
	}
	p.setGoogleHeaders(req, accessToken, false)
	resp, err := client.Do(req)
	if err != nil || resp == nil {
		return nil, false
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, false
	}
	var data map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		return nil, false
	}
	return data, true
}

func sleepContext(ctx context.Context, delay time.Duration) bool {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

func (p googleCodeAssistProvider) fetchGoogleEmail(ctx context.Context, client *http.Client, accessToken string) string {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://www.googleapis.com/oauth2/v2/userinfo", nil)
	if err != nil {
		return ""
	}
	p.setGoogleHeaders(req, accessToken, false)
	resp, err := client.Do(req)
	if err != nil || resp == nil {
		return ""
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return ""
	}
	var data map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		return ""
	}
	return stringValue(data["email"])
}

func extractGoogleProjectID(data map[string]any) string {
	if value := stringValue(data["cloudaicompanionProject"]); value != "" {
		return value
	}
	if project, ok := data["cloudaicompanionProject"].(map[string]any); ok {
		return stringValue(project["id"])
	}
	return ""
}

func extractGoogleTier(data map[string]any) string {
	if value := stringValue(data["currentTier"]); value != "" {
		return normalizeGoogleTierID(value)
	}
	if tier, ok := data["currentTier"].(map[string]any); ok {
		if id := stringValue(tier["id"]); id != "" {
			return normalizeGoogleTierID(id)
		}
		return normalizeGoogleTierID(stringValue(tier["name"]))
	}
	return ""
}

func extractAllowedTiers(data map[string]any) []map[string]any {
	items := anySlice(data["allowedTiers"])
	out := make([]map[string]any, 0, len(items))
	for _, raw := range items {
		item, _ := raw.(map[string]any)
		if item != nil {
			out = append(out, item)
		}
	}
	return out
}

func detectAntigravityTier(data map[string]any) string {
	detected := ""
	for _, tier := range extractAllowedTiers(data) {
		if tier["isDefault"] == true {
			detected = normalizeGoogleTierID(stringValue(tier["id"]))
			break
		}
	}
	if paidTier, ok := data["paidTier"].(map[string]any); ok {
		if id := normalizeGoogleTierID(stringValue(paidTier["id"])); id != "" && isPaidGoogleTierID(id) {
			return id
		}
	}
	return detected
}

func selectOnboardTier(fallback string, allowedTiers []map[string]any) string {
	for _, tier := range allowedTiers {
		if tier["isDefault"] == true {
			if id := stringValue(tier["id"]); id != "" {
				return id
			}
		}
	}
	for _, tier := range allowedTiers {
		if stringValue(tier["id"]) == "legacy-tier" {
			return "legacy-tier"
		}
	}
	if len(allowedTiers) > 0 {
		return stringValue(allowedTiers[0]["id"])
	}
	if fallback != "" {
		return fallback
	}
	return "free-tier"
}

func normalizeGoogleTierID(id string) string {
	return strings.ToLower(strings.TrimSpace(id))
}

func isPaidGoogleTierID(id string) bool {
	lower := normalizeGoogleTierID(id)
	switch lower {
	case "paid", "standard-tier":
		return true
	default:
		return false
	}
}

func (p googleCodeAssistProvider) setGoogleHeaders(req *http.Request, accessToken string, stream bool) {
	p.setGoogleHeadersWithMetadata(req, accessToken, stream, true)
}

func (p googleCodeAssistProvider) setGoogleGenerationHeaders(req *http.Request, accessToken string, stream bool) {
	p.setGoogleHeadersWithMetadata(req, accessToken, stream, true)
}

func (p googleCodeAssistProvider) setGoogleHeadersWithMetadata(req *http.Request, accessToken string, stream bool, includeClientMetadata bool) {
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(accessToken))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", map[bool]string{true: "text/event-stream", false: "application/json"}[stream])
	if p.userAgent != "" {
		req.Header.Set("User-Agent", p.userAgent)
	}
	if includeClientMetadata && p.apiClient != "" {
		req.Header.Set("X-Goog-Api-Client", p.apiClient)
	}
	if includeClientMetadata && p.clientMetadata != "" {
		req.Header.Set("Client-Metadata", p.clientMetadata)
	}
}

func codeAssistMetadata() map[string]any {
	return map[string]any{"ideType": "IDE_UNSPECIFIED", "platform": "PLATFORM_UNSPECIFIED", "pluginType": "GEMINI"}
}

func (p googleCodeAssistProvider) applyThinkingConfig(payload map[string]any, model, effort string, budget int) {
	if isImageGenerationModel(p.registry, model) {
		return
	}
	config := map[string]any{}
	if isGemini3ModelName(model) {
		level := ""
		if budget > 0 {
			level = p.thinkingLevelFromBudget(model, budget)
		} else if effort != "" && effort != "none" {
			level = p.thinkingLevelFromEffort(model, effort)
		}
		if level != "" {
			config["thinkingLevel"] = level
			config["includeThoughts"] = true
		}
	} else {
		format := providerConfigString(p.registry, model, p.name, "thinking_format")
		if format == "" {
			format = "budget"
		}
		if budget > 0 && format != "level" {
			config["thinkingBudget"] = budget
			config["includeThoughts"] = true
		} else if effort != "" && effort != "none" {
			if format == "level" {
				if level := p.thinkingLevel(model, effort); level != "" {
					config["thinkingLevel"] = level
				}
			} else {
				if thinkingBudget := p.thinkingBudget(model, effort); thinkingBudget > 0 {
					config["thinkingBudget"] = thinkingBudget
				}
			}
			config["includeThoughts"] = true
		}
	}
	if len(config) == 0 {
		return
	}
	generation, _ := payload["generationConfig"].(map[string]any)
	if generation == nil {
		generation = map[string]any{}
		payload["generationConfig"] = generation
	}
	generation["thinkingConfig"] = config
}

func (p googleCodeAssistProvider) normalizeGemini3ThinkingConfig(thinking map[string]any, model string) map[string]any {
	out := map[string]any{}
	if include, ok := defaultAny(thinking["includeThoughts"], thinking["include_thoughts"]).(bool); ok {
		out["includeThoughts"] = include
	}
	level := defaultStringValue(thinking["thinkingLevel"], stringValue(thinking["thinking_level"]))
	if level == "" {
		if budget := numberFromAny(defaultAny(thinking["thinkingBudget"], thinking["thinking_budget"])); budget > 0 {
			level = p.thinkingLevelFromBudget(model, budget)
		}
	} else {
		level = p.normalizeGemini3ThinkingLevel(model, level)
	}
	if level == "" {
		level = geminiThinkingLevelFromModel(model)
	}
	if level != "" {
		out["thinkingLevel"] = level
		if _, ok := out["includeThoughts"]; !ok {
			out["includeThoughts"] = true
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func (p googleCodeAssistProvider) ensureGemini3MaxOutputTokens(generation map[string]any, model, level string) {
	budgets := providerConfigIntMap(p.registry, model, p.name, "thinking_budgets")
	budget := budgets[level]
	if budget <= 0 {
		return
	}
	if maxTokens := numberFromAny(defaultAny(generation["maxOutputTokens"], generation["max_output_tokens"])); maxTokens == 0 || maxTokens <= budget {
		generation["maxOutputTokens"] = 64000
		delete(generation, "max_output_tokens")
	}
}

func isGemini3ModelName(model string) bool {
	model = strings.ToLower(lastModelSegment(model))
	return strings.HasPrefix(model, "gemini-3")
}

func geminiThinkingLevelFromModel(model string) string {
	model = strings.ToLower(lastModelSegment(model))
	for _, level := range []string{"minimal", "low", "medium", "high"} {
		if strings.HasSuffix(model, "-"+level) {
			return level
		}
	}
	return ""
}

func (p googleCodeAssistProvider) thinkingLevelFromBudget(model string, budget int) string {
	effort := "high"
	budgets := providerConfigIntMap(p.registry, model, p.name, "thinking_budgets")
	if low := budgets["low"]; low > 0 && budget <= low {
		effort = "low"
	} else if medium := budgets["medium"]; medium > 0 && budget <= medium {
		effort = "medium"
	} else if len(budgets) == 0 {
		if budget <= 8192 {
			effort = "low"
		} else if budget <= 16384 {
			effort = "medium"
		}
	}
	if level := p.thinkingLevel(model, effort); level != "" {
		return p.normalizeGemini3ThinkingLevel(model, level)
	}
	return p.normalizeGemini3ThinkingLevel(model, effort)
}

func (p googleCodeAssistProvider) thinkingLevelFromEffort(model, effort string) string {
	if level := p.thinkingLevel(model, effort); level != "" {
		return p.normalizeGemini3ThinkingLevel(model, level)
	}
	return p.normalizeGemini3ThinkingLevel(model, effort)
}

func (p googleCodeAssistProvider) normalizeGemini3ThinkingLevel(model, level string) string {
	level = strings.ToLower(strings.TrimSpace(level))
	switch level {
	case "xhigh":
		return "high"
	case "minimal":
		if strings.Contains(strings.ToLower(model), "pro") {
			return "low"
		}
		return "minimal"
	case "medium":
		lower := strings.ToLower(model)
		if strings.Contains(lower, "pro") && !strings.Contains(lower, "gemini-3.1-pro") {
			return "high"
		}
		return "medium"
	case "low", "high":
		return level
	default:
		return ""
	}
}

func (p googleCodeAssistProvider) thinkingLevel(model, effort string) string {
	levels := providerConfigStringMap(p.registry, model, p.name, "thinking_levels")
	if len(levels) == 0 {
		return ""
	}
	if level := levels[effort]; level != "" {
		return level
	}
	return levels["high"]
}

func (p googleCodeAssistProvider) thinkingBudget(model, effort string) int {
	budgets := providerConfigIntMap(p.registry, model, p.name, "thinking_budgets")
	if len(budgets) == 0 {
		return 0
	}
	if budget := budgets[effort]; budget > 0 {
		return budget
	}
	return budgets["high"]
}

func openAIToGemini(body map[string]any) map[string]any {
	messages, _ := body["messages"].([]any)
	contents := []any{}
	systemParts := []any{}
	completedToolCallIDs := completedToolCallIDs(messages)
	toolUseIDs := toolUseIDs(messages)
	validToolResultIDs := validToolResultIDs(messages)
	for _, raw := range messages {
		msg, _ := raw.(map[string]any)
		role := stringValue(msg["role"])
		if role == "system" || role == "developer" {
			systemParts = append(systemParts, openAIContentTextParts(msg["content"])...)
			continue
		}
		parts := openAIContentToGeminiParts(msg["content"])
		parts = append(parts, openAIToolCallsToGeminiParts(msg, completedToolCallIDs)...)
		if role == "tool" {
			toolCallID := stringValue(msg["tool_call_id"])
			if toolCallID == "" || !validToolResultIDs[toolCallID] || !toolUseIDs[toolCallID] {
				continue
			}
			parts = []any{map[string]any{"functionResponse": map[string]any{"name": defaultStringValue(msg["name"], "unknown"), "id": toolCallID, "response": map[string]any{"result": msg["content"]}}}}
		}
		geminiRole := "user"
		if role == "assistant" {
			geminiRole = "model"
		}
		if len(parts) > 0 {
			contents = append(contents, map[string]any{"role": geminiRole, "parts": parts})
		}
	}
	contents = separateTextAndToolParts(groupConsecutiveToolResponses(sanitizeGeminiContents(contents)))
	payload := map[string]any{"contents": contents}
	if len(systemParts) > 0 {
		payload["systemInstruction"] = map[string]any{"parts": systemParts}
	}
	generation := map[string]any{}
	if body["temperature"] != nil {
		generation["temperature"] = body["temperature"]
	}
	if body["top_p"] != nil {
		generation["topP"] = body["top_p"]
	}
	if body["max_tokens"] != nil {
		generation["maxOutputTokens"] = body["max_tokens"]
	}
	if body["stop"] != nil {
		if stops, ok := body["stop"].([]any); ok {
			generation["stopSequences"] = stops
		} else if stop := stringValue(body["stop"]); stop != "" {
			generation["stopSequences"] = []any{stop}
		}
	}
	if thinking := requestThinkingConfig(body); len(thinking) > 0 {
		generation["thinkingConfig"] = thinking
	}
	if len(generation) > 0 {
		payload["generationConfig"] = generation
	}
	if tools := geminiTools(body["tools"]); len(tools) > 0 {
		payload["tools"] = []any{map[string]any{"functionDeclarations": tools}}
	}
	for _, key := range []string{"cached_content", "cachedContent", "extra_body", "system_instruction"} {
		if body[key] != nil {
			payload[key] = body[key]
		}
	}
	payload["safetySettings"] = []any{
		map[string]any{"category": "HARM_CATEGORY_HARASSMENT", "threshold": "OFF"},
		map[string]any{"category": "HARM_CATEGORY_HATE_SPEECH", "threshold": "OFF"},
		map[string]any{"category": "HARM_CATEGORY_SEXUALLY_EXPLICIT", "threshold": "OFF"},
		map[string]any{"category": "HARM_CATEGORY_DANGEROUS_CONTENT", "threshold": "OFF"},
	}
	return payload
}

func openAIContentTextParts(content any) []any {
	if text, ok := content.(string); ok {
		return []any{map[string]any{"text": text}}
	}
	parts := []any{}
	for _, raw := range anySlice(content) {
		item, _ := raw.(map[string]any)
		if item["type"] != "text" {
			continue
		}
		if text := stringValue(item["text"]); text != "" {
			parts = append(parts, map[string]any{"text": text})
		}
	}
	return parts
}

func completedToolCallIDs(messages []any) map[string]bool {
	ids := map[string]bool{}
	for _, raw := range messages {
		msg, _ := raw.(map[string]any)
		if msg == nil {
			continue
		}
		if stringValue(msg["role"]) == "tool" {
			if id := stringValue(msg["tool_call_id"]); id != "" {
				ids[id] = true
			}
		}
		if stringValue(msg["role"]) == "user" {
			for _, rawBlock := range anySlice(msg["content"]) {
				block, _ := rawBlock.(map[string]any)
				if block["type"] == "tool_result" {
					if id := stringValue(block["tool_use_id"]); id != "" {
						ids[id] = true
					}
				}
			}
		}
	}
	return ids
}

func toolUseIDs(messages []any) map[string]bool {
	ids := map[string]bool{}
	for _, raw := range messages {
		msg, _ := raw.(map[string]any)
		if stringValue(msg["role"]) != "assistant" {
			continue
		}
		for _, rawCall := range anySlice(msg["tool_calls"]) {
			call, _ := rawCall.(map[string]any)
			if id := stringValue(call["id"]); id != "" {
				ids[id] = true
			}
		}
	}
	return ids
}

func validToolResultIDs(messages []any) map[string]bool {
	valid := map[string]bool{}
	lastAssistantToolCallIDs := map[string]bool{}
	for _, raw := range messages {
		msg, _ := raw.(map[string]any)
		role := stringValue(msg["role"])
		switch role {
		case "assistant":
			lastAssistantToolCallIDs = map[string]bool{}
			for _, rawCall := range anySlice(msg["tool_calls"]) {
				call, _ := rawCall.(map[string]any)
				if id := stringValue(call["id"]); id != "" {
					lastAssistantToolCallIDs[id] = true
				}
			}
		case "tool":
			if id := stringValue(msg["tool_call_id"]); id != "" && lastAssistantToolCallIDs[id] {
				valid[id] = true
			}
		case "user":
			hasToolResults := false
			for _, rawBlock := range anySlice(msg["content"]) {
				block, _ := rawBlock.(map[string]any)
				if block["type"] != "tool_result" {
					continue
				}
				hasToolResults = true
				if id := stringValue(block["tool_use_id"]); id != "" && lastAssistantToolCallIDs[id] {
					valid[id] = true
				}
			}
			if !hasToolResults {
				lastAssistantToolCallIDs = map[string]bool{}
			}
		case "system", "developer":
			lastAssistantToolCallIDs = map[string]bool{}
		}
	}
	return valid
}

func openAIToolCallsToGeminiParts(msg map[string]any, completed map[string]bool) []any {
	parts := []any{}
	for _, rawCall := range anySlice(msg["tool_calls"]) {
		call, _ := rawCall.(map[string]any)
		id := stringValue(call["id"])
		if id != "" && !completed[id] {
			continue
		}
		fn, _ := call["function"].(map[string]any)
		name := stringValue(fn["name"])
		if name == "" {
			continue
		}
		args := map[string]any{}
		if rawArgs := stringValue(fn["arguments"]); rawArgs != "" {
			_ = json.Unmarshal([]byte(rawArgs), &args)
		}
		parts = append(parts, map[string]any{"functionCall": map[string]any{"name": name, "args": args, "id": id}})
	}
	return parts
}

func sanitizeGeminiContents(contents []any) []any {
	callIdx := map[string]int{}
	responseIdx := map[string]int{}
	for idx, rawContent := range contents {
		content, _ := rawContent.(map[string]any)
		for _, rawPart := range anySlice(content["parts"]) {
			part, _ := rawPart.(map[string]any)
			if fn, ok := part["functionCall"].(map[string]any); ok {
				if id := stringValue(fn["id"]); id != "" {
					callIdx[id] = idx
				}
			}
			if fn, ok := part["functionResponse"].(map[string]any); ok {
				if id := stringValue(fn["id"]); id != "" {
					responseIdx[id] = idx
				}
			}
		}
	}
	validCalls := map[string]bool{}
	validResponses := map[string]bool{}
	for id, callAt := range callIdx {
		if responseAt, ok := responseIdx[id]; ok && responseAt > callAt {
			validCalls[id] = true
			validResponses[id] = true
		}
	}
	out := []any{}
	for _, rawContent := range contents {
		content, _ := rawContent.(map[string]any)
		parts := []any{}
		for _, rawPart := range anySlice(content["parts"]) {
			part, _ := rawPart.(map[string]any)
			if fn, ok := part["functionCall"].(map[string]any); ok {
				if !validCalls[stringValue(fn["id"])] {
					continue
				}
			}
			if fn, ok := part["functionResponse"].(map[string]any); ok {
				if !validResponses[stringValue(fn["id"])] {
					continue
				}
			}
			parts = append(parts, rawPart)
		}
		if len(parts) > 0 {
			copyContent := cloneAnyMap(content)
			copyContent["parts"] = parts
			out = append(out, copyContent)
		}
	}
	return out
}

func groupConsecutiveToolResponses(contents []any) []any {
	out := []any{}
	for _, rawContent := range contents {
		content, _ := rawContent.(map[string]any)
		parts := anySlice(content["parts"])
		if content["role"] == "user" && hasFunctionResponsePart(parts) && len(out) > 0 {
			last, _ := out[len(out)-1].(map[string]any)
			lastParts := anySlice(last["parts"])
			if last["role"] == "user" && hasFunctionResponsePart(lastParts) {
				last["parts"] = append(lastParts, parts...)
				continue
			}
		}
		copyContent := cloneAnyMap(content)
		copyContent["parts"] = append([]any{}, parts...)
		out = append(out, copyContent)
	}
	return out
}

func hasFunctionResponsePart(parts []any) bool {
	for _, rawPart := range parts {
		part, _ := rawPart.(map[string]any)
		if part["functionResponse"] != nil {
			return true
		}
	}
	return false
}

func separateTextAndToolParts(contents []any) []any {
	out := []any{}
	for _, rawContent := range contents {
		content, _ := rawContent.(map[string]any)
		parts := anySlice(content["parts"])
		if len(parts) == 0 {
			out = append(out, rawContent)
			continue
		}
		textParts, thoughtParts, callParts, responseParts, otherParts := splitGeminiParts(parts)
		switch content["role"] {
		case "model":
			if len(callParts) > 0 && len(textParts)+len(thoughtParts) > 0 {
				appendContentParts(&out, content, append(append(thoughtParts, textParts...), otherParts...))
				appendContentParts(&out, content, callParts)
			} else {
				out = append(out, rawContent)
			}
		case "user":
			if len(responseParts) > 0 {
				appendContentParts(&out, content, append(responseParts, otherParts...))
			} else {
				out = append(out, rawContent)
			}
		default:
			out = append(out, rawContent)
		}
	}
	return out
}

func splitGeminiParts(parts []any) ([]any, []any, []any, []any, []any) {
	textParts, thoughtParts, callParts, responseParts, otherParts := []any{}, []any{}, []any{}, []any{}, []any{}
	for _, rawPart := range parts {
		part, _ := rawPart.(map[string]any)
		switch {
		case part["functionCall"] != nil:
			callParts = append(callParts, rawPart)
		case part["functionResponse"] != nil:
			responseParts = append(responseParts, rawPart)
		case part["thought"] == true:
			thoughtParts = append(thoughtParts, rawPart)
		case part["text"] != nil:
			textParts = append(textParts, rawPart)
		default:
			otherParts = append(otherParts, rawPart)
		}
	}
	return textParts, thoughtParts, callParts, responseParts, otherParts
}

func appendContentParts(target *[]any, content map[string]any, parts []any) {
	if len(parts) == 0 {
		return
	}
	copyContent := cloneAnyMap(content)
	copyContent["parts"] = parts
	*target = append(*target, copyContent)
}

func requestThinkingConfig(body map[string]any) map[string]any {
	config := map[string]any{}
	budget := numberFromAny(body["thinking_budget"])
	effort := defaultStringValue(reasoningEffort(body["reasoning"]), stringValue(body["reasoning_effort"]))
	if budget > 0 {
		config["thinkingBudget"] = budget
	} else if effort != "" && effort != "none" {
		if budget := defaultThinkingBudget(effort); budget > 0 {
			config["thinkingBudget"] = budget
		}
	}
	if len(config) > 0 && body["include_thoughts"] != nil {
		config["include_thoughts"] = body["include_thoughts"]
	}
	return config
}

func reasoningEffort(value any) string {
	reasoning, _ := value.(map[string]any)
	return stringValue(reasoning["effort"])
}

func defaultThinkingBudget(effort string) int {
	switch effort {
	case "low":
		return 1024
	case "medium":
		return 10000
	case "high", "xhigh":
		return 32000
	default:
		return 0
	}
}

const antigravitySystemInstruction = "You are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team working on Advanced Agentic Coding.You are pair programming with a USER to solve their coding task. The task may require creating a new codebase, modifying or debugging an existing codebase, or simply answering a question.**Absolute paths only****Proactiveness**"

func (p googleCodeAssistProvider) applyAntigravitySystemInstruction(payload map[string]any, model string) {
	if isImageGenerationModel(p.registry, model) {
		return
	}
	normalizedModel := strings.ToLower(model)
	needsInjection := strings.Contains(normalizedModel, "claude") || strings.Contains(normalizedModel, "gemini-3-pro") || strings.Contains(normalizedModel, "gemini-3.1-pro") || strings.Contains(normalizedModel, "gemini-3-flash")
	if !needsInjection {
		return
	}
	parts := []any{map[string]any{"text": antigravitySystemInstruction}}
	existingRecord := map[string]any{}
	if text := stringValue(payload["systemInstruction"]); text != "" {
		parts = append(parts, map[string]any{"text": text})
	} else if existing, ok := payload["systemInstruction"].(map[string]any); ok {
		existingRecord = cloneAnyMap(existing)
		if existingParts, ok := existing["parts"].([]any); ok {
			parts = append(parts, existingParts...)
		}
	}
	existingRecord["role"] = "user"
	existingRecord["parts"] = parts
	payload["systemInstruction"] = existingRecord
}

func openAIContentToGeminiParts(content any) []any {
	if content == nil {
		return nil
	}
	if text, ok := content.(string); ok {
		return []any{map[string]any{"text": text}}
	}
	items, _ := content.([]any)
	parts := []any{}
	for _, raw := range items {
		item, _ := raw.(map[string]any)
		if text := stringValue(item["text"]); text != "" {
			parts = append(parts, map[string]any{"text": text})
			continue
		}
		if item["type"] == "image_url" {
			imageURL, _ := item["image_url"].(map[string]any)
			url := stringValue(imageURL["url"])
			if part := dataURIToGeminiPart(url); part != nil {
				parts = append(parts, part)
			} else if url != "" {
				parts = append(parts, map[string]any{"fileData": map[string]any{"fileUri": url, "mimeType": inferMimeTypeFromURL(url)}})
			}
		}
	}
	return parts
}

func inferMimeTypeFromURL(value string) string {
	parsed, err := url.Parse(value)
	if err != nil {
		return "image/jpeg"
	}
	segments := strings.Split(strings.ToLower(parsed.Path), ".")
	ext := segments[len(segments)-1]
	switch ext {
	case "png":
		return "image/png"
	case "gif":
		return "image/gif"
	case "webp":
		return "image/webp"
	case "svg":
		return "image/svg+xml"
	case "bmp":
		return "image/bmp"
	case "ico":
		return "image/x-icon"
	case "tiff", "tif":
		return "image/tiff"
	case "pdf":
		return "application/pdf"
	case "mp4":
		return "video/mp4"
	case "webm":
		return "video/webm"
	case "mov":
		return "video/quicktime"
	case "avi":
		return "video/x-msvideo"
	case "mp3":
		return "audio/mpeg"
	case "wav":
		return "audio/wav"
	case "ogg":
		return "audio/ogg"
	default:
		return "image/jpeg"
	}
}

func dataURIToGeminiPart(value string) map[string]any {
	if !strings.HasPrefix(value, "data:") {
		return nil
	}
	comma := strings.Index(value, ",")
	if comma == -1 {
		return nil
	}
	meta := value[len("data:"):comma]
	mimeType := strings.Split(meta, ";")[0]
	if mimeType == "" {
		mimeType = "image/png"
	}
	return map[string]any{"inlineData": map[string]any{"mimeType": mimeType, "data": value[comma+1:]}}
}

func geminiTools(raw any) []any {
	tools, _ := raw.([]any)
	out := []any{}
	for _, item := range tools {
		tool, _ := item.(map[string]any)
		fn, _ := tool["function"].(map[string]any)
		name := stringValue(fn["name"])
		if name == "" {
			continue
		}
		params, ok := fn["parameters"].(map[string]any)
		if !ok {
			params = map[string]any{"type": "object", "properties": map[string]any{}}
		}
		params = sanitizeGoogleFunctionSchema(params)
		out = append(out, map[string]any{"name": name, "description": defaultStringValue(fn["description"], ""), "parameters": params})
	}
	return out
}

func sanitizeGoogleFunctionSchema(schema map[string]any) map[string]any {
	if schema == nil {
		return nil
	}
	out := map[string]any{}
	for key, value := range schema {
		switch key {
		case "type":
			if typ := normalizeSchemaType(value); typ != "" {
				out["type"] = typ
			}
		case "properties":
			props, _ := value.(map[string]any)
			if len(props) == 0 {
				continue
			}
			cleaned := map[string]any{}
			for name, rawProp := range props {
				if prop, ok := rawProp.(map[string]any); ok {
					cleaned[name] = sanitizeGoogleFunctionSchema(prop)
				}
			}
			if len(cleaned) > 0 {
				out["properties"] = cleaned
			}
		case "items":
			if items, ok := value.(map[string]any); ok {
				out["items"] = sanitizeGoogleFunctionSchema(items)
			}
		case "anyOf":
			items := []any{}
			for _, rawItem := range anySlice(value) {
				if item, ok := rawItem.(map[string]any); ok {
					items = append(items, sanitizeGoogleFunctionSchema(item))
				}
			}
			if len(items) > 0 {
				out["anyOf"] = items
			}
		case "description", "format", "nullable", "enum", "required", "propertyOrdering", "minimum", "maximum", "minItems", "maxItems", "minLength", "maxLength", "pattern", "title", "default", "example", "minProperties", "maxProperties":
			out[key] = value
		}
	}
	if schemaTypeAllowsNull(schema["type"]) && out["nullable"] == nil {
		out["nullable"] = true
	}
	if value, ok := schema["const"]; ok && out["enum"] == nil {
		out["enum"] = []any{value}
	}
	if out["type"] == nil {
		if out["properties"] != nil {
			out["type"] = "object"
		} else if out["items"] != nil {
			out["type"] = "array"
		}
	}
	return out
}

func schemaTypeAllowsNull(value any) bool {
	for _, raw := range anySlice(value) {
		if stringValue(raw) == "null" {
			return true
		}
	}
	return false
}

type schemaInfo struct {
	typ string
}

type toolSchemaMap map[string]map[string]schemaInfo

func buildToolSchemaMap(raw any) toolSchemaMap {
	result := toolSchemaMap{}
	for _, tool := range mapSlice(raw) {
		for _, decl := range mapSlice(tool["functionDeclarations"]) {
			originalName := stringValue(decl["name"])
			if originalName == "" {
				continue
			}
			schema, _ := defaultAny(decl["parametersJsonSchema"], decl["parameters"]).(map[string]any)
			props, _ := schema["properties"].(map[string]any)
			if len(props) == 0 {
				continue
			}
			paramMap := map[string]schemaInfo{}
			for paramName, rawParam := range props {
				param, _ := rawParam.(map[string]any)
				paramMap[paramName] = schemaInfo{typ: defaultEmpty(normalizeSchemaType(param["type"]), "unknown")}
			}
			sanitizedName := sanitizedToolName(originalName)
			result[sanitizedName] = paramMap
			if sanitizedName != originalName {
				result[originalName] = paramMap
			}
		}
	}
	return result
}

func sanitizeToolSchemaKeys(schemas toolSchemaMap) {
	for name, params := range schemas {
		sanitized := sanitizedToolName(name)
		if sanitized != name {
			schemas[sanitized] = params
		}
	}
}

func sanitizedToolName(name string) string {
	if name != "" && name[0] >= '0' && name[0] <= '9' {
		return "t_" + name
	}
	return name
}

func normalizeToolCallArgs(args any, toolName string, schemas toolSchemaMap) any {
	record, ok := args.(map[string]any)
	if !ok || record == nil {
		return args
	}
	params := schemas[toolName]
	result := map[string]any{}
	for key, value := range record {
		expectedType := params[key].typ
		if expectedType == "string" {
			result[key] = processEscapeSequencesOnly(value)
			continue
		}
		if text, ok := value.(string); ok && (expectedType == "array" || expectedType == "object") {
			var parsed any
			if err := json.Unmarshal([]byte(text), &parsed); err == nil {
				result[key] = parsed
			} else {
				result[key] = processEscapeSequencesOnly(value)
			}
			continue
		}
		result[key] = processEscapeSequencesOnly(value)
	}
	return result
}

func processEscapeSequencesOnly(value any) any {
	text, ok := value.(string)
	if !ok {
		return value
	}
	if (!strings.Contains(text, `\n`) && !strings.Contains(text, `\t`)) || strings.Contains(text, `\"`) || strings.Contains(text, `\\`) {
		return value
	}
	var unescaped string
	if err := json.Unmarshal([]byte(`"`+strings.ReplaceAll(text, `"`, `\"`)+`"`), &unescaped); err == nil {
		return unescaped
	}
	return value
}

func unwrapGeminiResponse(data any) map[string]any {
	if items, ok := data.([]any); ok {
		for _, item := range items {
			if unwrapped := unwrapGeminiResponse(item); len(unwrapped) > 0 {
				return unwrapped
			}
		}
		return map[string]any{}
	}
	obj, _ := data.(map[string]any)
	if response, ok := obj["response"].(map[string]any); ok {
		return response
	}
	return obj
}

func (p googleCodeAssistProvider) geminiSSEToOpenAISSEReader(ctx context.Context, source io.Reader, model string, sessionID string, schemas toolSchemaMap) io.Reader {
	reader, writer := io.Pipe()
	go func() {
		completionID := randomID("chatcmpl")
		scanner := bufio.NewScanner(source)
		scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
		sentRole := false
		toolIndex := 0
		hasToolCalls := false
		sentFinal := false
		var trackedUsage map[string]any
		writeChunk := func(delta map[string]any, finish any, usage map[string]any) {
			chunk := map[string]any{"id": completionID, "object": "chat.completion.chunk", "created": time.Now().Unix(), "model": model, "choices": []any{map[string]any{"index": 0, "delta": delta, "finish_reason": finish}}}
			if usage != nil {
				chunk["usage"] = usage
			}
			encoded, _ := json.Marshal(chunk)
			_, _ = writer.Write([]byte("data: " + string(encoded) + "\n\n"))
		}
		for scanner.Scan() {
			line := strings.TrimSpace(scanner.Text())
			if !strings.HasPrefix(line, "data:") {
				continue
			}
			dataText := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
			if dataText == "" || dataText == "[DONE]" {
				continue
			}
			var parsed any
			if err := json.Unmarshal([]byte(dataText), &parsed); err != nil {
				continue
			}
			response := unwrapGeminiResponse(parsed)
			p.cacheSignaturesFromResponse(ctx, response, model, sessionID)
			if usage := geminiUsage(response); usage != nil {
				trackedUsage = usage
			}
			for _, delta := range geminiDeltas(response, schemas, &toolIndex) {
				if !sentRole {
					writeChunk(map[string]any{"role": "assistant", "content": ""}, nil, nil)
					sentRole = true
				}
				if delta["tool_calls"] != nil {
					hasToolCalls = true
				}
				writeChunk(delta, nil, nil)
			}
			if finish, ok := geminiFinishReason(response, hasToolCalls); ok {
				writeChunk(map[string]any{}, finish, nil)
				sentFinal = true
			}
		}
		if trackedUsage != nil {
			writeChunk(map[string]any{}, nil, trackedUsage)
		}
		if !sentFinal {
			writeChunk(map[string]any{}, map[bool]string{true: "tool_calls", false: "stop"}[hasToolCalls], nil)
		}
		_, _ = writer.Write([]byte("data: [DONE]\n\n"))
		_ = writer.Close()
	}()
	return reader
}

func geminiToOpenAICompletion(response map[string]any, model string, schemas toolSchemaMap) map[string]any {
	content := ""
	reasoning := ""
	toolCalls := []any{}
	toolIndex := 0
	for _, delta := range geminiDeltas(response, schemas, &toolIndex) {
		content += stringValue(delta["content"])
		reasoning += stringValue(delta["reasoning_content"])
		if calls, ok := delta["tool_calls"].([]any); ok {
			toolCalls = append(toolCalls, calls...)
		}
	}
	message := map[string]any{"role": "assistant", "content": nil}
	if content != "" {
		message["content"] = content
	}
	if reasoning != "" {
		message["reasoning_content"] = reasoning
	}
	finish := "stop"
	if len(toolCalls) > 0 {
		message["tool_calls"] = stripToolCallIndexes(toolCalls)
		finish = "tool_calls"
	} else if mapped, ok := geminiFinishReason(response, false); ok {
		finish = mapped
	}
	usage := geminiUsage(response)
	if usage == nil {
		usage = map[string]any{"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
	}
	return map[string]any{"id": randomID("chatcmpl"), "object": "chat.completion", "created": time.Now().Unix(), "model": model, "choices": []any{map[string]any{"index": 0, "message": message, "finish_reason": finish}}, "usage": usage}
}

func (p googleCodeAssistProvider) geminiStreamToOpenAICompletion(ctx context.Context, source io.Reader, model string, sessionID string, schemas toolSchemaMap) map[string]any {
	content := ""
	reasoning := ""
	toolCalls := []any{}
	var usage map[string]any
	finish := "stop"
	toolIndex := 0
	scanner := bufio.NewScanner(source)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		dataText := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if dataText == "" || dataText == "[DONE]" {
			continue
		}
		var parsed any
		if err := json.Unmarshal([]byte(dataText), &parsed); err != nil {
			continue
		}
		response := unwrapGeminiResponse(parsed)
		p.cacheSignaturesFromResponse(ctx, response, model, sessionID)
		for _, delta := range geminiDeltas(response, schemas, &toolIndex) {
			content += stringValue(delta["content"])
			reasoning += stringValue(delta["reasoning_content"])
			if calls, ok := delta["tool_calls"].([]any); ok {
				toolCalls = append(toolCalls, calls...)
			}
		}
		if nextUsage := geminiUsage(response); nextUsage != nil {
			usage = nextUsage
		}
		if mapped, ok := geminiFinishReason(response, len(toolCalls) > 0); ok {
			finish = mapped
		}
	}
	message := map[string]any{"role": "assistant", "content": nil}
	if content != "" {
		message["content"] = content
	}
	if reasoning != "" {
		message["reasoning_content"] = reasoning
	}
	if len(toolCalls) > 0 {
		message["tool_calls"] = stripToolCallIndexes(toolCalls)
		finish = "tool_calls"
	}
	if usage == nil {
		usage = map[string]any{"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
	}
	return map[string]any{"id": randomID("chatcmpl"), "object": "chat.completion", "created": time.Now().Unix(), "model": model, "choices": []any{map[string]any{"index": 0, "message": message, "finish_reason": finish}}, "usage": usage}
}

func (p googleCodeAssistProvider) cacheSignaturesFromResponse(ctx context.Context, response map[string]any, model, sessionID string) {
	for _, rawCandidate := range anySlice(response["candidates"]) {
		candidate, _ := rawCandidate.(map[string]any)
		content, _ := candidate["content"].(map[string]any)
		for _, rawPart := range anySlice(content["parts"]) {
			part, _ := rawPart.(map[string]any)
			if part["thought"] == true {
				text := stringValue(part["text"])
				signature := stringValue(part["thoughtSignature"])
				if text != "" && signature != "" {
					p.cacheSignature(ctx, model, sessionID, text, signature)
				}
			}
		}
	}
}

func geminiDeltas(response map[string]any, schemas toolSchemaMap, toolIndex *int) []map[string]any {
	deltas := []map[string]any{}
	candidates, _ := response["candidates"].([]any)
	for _, rawCandidate := range candidates {
		candidate, _ := rawCandidate.(map[string]any)
		content, _ := candidate["content"].(map[string]any)
		parts, _ := content["parts"].([]any)
		localToolIndex := 0
		for _, rawPart := range parts {
			part, _ := rawPart.(map[string]any)
			if fn, ok := part["functionCall"].(map[string]any); ok {
				name := stringValue(fn["name"])
				args := normalizeToolCallArgs(fn["args"], name, schemas)
				encodedArgs, _ := json.Marshal(args)
				if len(encodedArgs) == 0 || string(encodedArgs) == "null" {
					encodedArgs = []byte("{}")
				}
				id := stringValue(fn["id"])
				if id == "" {
					id = randomID("call")
				}
				idx := localToolIndex
				if toolIndex != nil {
					idx = *toolIndex
					*toolIndex = *toolIndex + 1
				} else {
					localToolIndex++
				}
				deltas = append(deltas, map[string]any{"tool_calls": []any{map[string]any{"index": idx, "id": id, "type": "function", "function": map[string]any{"name": name, "arguments": string(encodedArgs)}}}})
				continue
			}
			text := stringValue(part["text"])
			if text == "" {
				continue
			}
			if part["thought"] == true {
				deltas = append(deltas, map[string]any{"reasoning_content": text})
			} else {
				deltas = append(deltas, map[string]any{"content": text})
			}
		}
	}
	return deltas
}

func stripToolCallIndexes(calls []any) []any {
	out := make([]any, 0, len(calls))
	for _, rawCall := range calls {
		call, ok := rawCall.(map[string]any)
		if !ok {
			out = append(out, rawCall)
			continue
		}
		copyCall := cloneAnyMap(call)
		delete(copyCall, "index")
		out = append(out, copyCall)
	}
	return out
}

func geminiUsage(response map[string]any) map[string]any {
	rawUsage, ok := response["usageMetadata"].(map[string]any)
	if !ok {
		return nil
	}
	return map[string]any{"prompt_tokens": numberFromAny(rawUsage["promptTokenCount"]), "completion_tokens": numberFromAny(rawUsage["candidatesTokenCount"]), "total_tokens": numberFromAny(rawUsage["totalTokenCount"])}
}

func geminiFinishReason(response map[string]any, hasToolCalls bool) (string, bool) {
	for _, rawCandidate := range anySlice(response["candidates"]) {
		candidate, _ := rawCandidate.(map[string]any)
		finish := stringValue(candidate["finishReason"])
		if finish == "" {
			continue
		}
		if hasToolCalls {
			return "tool_calls", true
		}
		switch finish {
		case "MAX_TOKENS":
			return "length", true
		case "TOOL_CALLS":
			return "tool_calls", true
		default:
			return "stop", true
		}
	}
	return "", false
}
