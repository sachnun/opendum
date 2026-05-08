package providers

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"runtime"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"

	appdb "github.com/opendum/opendum/apps/proxy/internal/db"
	"github.com/opendum/opendum/apps/proxy/internal/models"
)

const googleOAuthTokenEndpoint = "https://oauth2.googleapis.com/token"
const antigravitySignatureCachePrefix = "opendum:thought-signature"
const antigravitySignatureCacheTTL = 24 * time.Hour
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
	body = p.normalizeBodyForModel(body, modelName)
	includeReasoning := body["_includeReasoning"] == true || providerConfigBool(p.registry, modelName, p.name, "thinking_model")
	if providerConfigBool(p.registry, modelName, p.name, "convert_external_images") {
		if messages, ok := body["messages"].([]any); ok {
			body["messages"] = convertImageURLsToBase64(ctx, client, messages)
		}
	}
	sessionID := stableSessionID(body)
	geminiPayload := openAIToGemini(body)
	if p.name == "antigravity" {
		p.transformAntigravityPayload(ctx, geminiPayload, modelName, sessionID)
	}
	p.applyThinkingConfig(geminiPayload, modelName, stringValue(body["reasoning_effort"]), numberFromAny(body["thinking_budget"]))
	requestPayload := p.wrapCodeAssistPayload(projectID, modelName, geminiPayload)
	actualStream := stream
	if providerConfigBool(p.registry, modelName, p.name, "force_stream_non_stream") && !stream {
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
		p.setGoogleHeaders(req, accessToken, actualStream)
		if p.name == "antigravity" && providerConfigBool(p.registry, modelName, p.name, "anthropic_beta_thinking") {
			req.Header.Set("anthropic-beta", "interleaved-thinking-2025-05-14")
		}
		resp, err := client.Do(req)
		if err != nil {
			lastErr = err
			continue
		}
		if resp.StatusCode == http.StatusTooManyRequests {
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
			return resp, nil
		}
		lastResp = resp
		lastErr = nil
		break
	}
	resp := lastResp
	if lastErr != nil || resp == nil || resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return resp, lastErr
	}
	if stream {
		return sseResponse(p.geminiSSEToOpenAISSEReader(ctx, resp.Body, modelName, includeReasoning, sessionID), resp.Body), nil
	}
	if actualStream {
		completion := p.geminiStreamToOpenAICompletion(ctx, resp.Body, modelName, includeReasoning, sessionID)
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
	return jsonResponse(http.StatusOK, geminiToOpenAICompletion(response, modelName, includeReasoning)), nil
}

func (p googleCodeAssistProvider) wrapCodeAssistPayload(projectID, model string, geminiPayload map[string]any) map[string]any {
	if p.name != "antigravity" {
		return map[string]any{"model": model, "project": projectID, "user_prompt_id": randomID("prompt"), "request": geminiPayload}
	}
	requestID := randomID("agent")
	return map[string]any{"project": projectID, "model": model, "userAgent": "antigravity", "requestType": "agent", "requestId": requestID, "request": geminiPayload}
}

func (p googleCodeAssistProvider) transformAntigravityPayload(ctx context.Context, payload map[string]any, model, sessionID string) {
	delete(payload, "safetySettings")
	p.normalizeCachedContent(payload)
	if isImageGenerationModel(p.registry, model) {
		delete(payload, "tools")
		delete(payload, "toolConfig")
	} else {
		ensureToolConfig(payload)
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
	p.ensureThinkingModelConfig(payload, model)
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
}

func (p googleCodeAssistProvider) resolveModel(model string) string {
	model = strings.TrimSuffix(lastModelSegment(model), ":thinking")
	if p.registry != nil {
		model = p.registry.UpstreamModelName(model, p.name)
	}
	return model
}

func (p googleCodeAssistProvider) normalizeBodyForModel(body map[string]any, model string) map[string]any {
	out := cloneAnyMap(body)
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
				decl["parameters"] = params
			}
			delete(params, "$schema")
			if params["type"] == nil {
				params["type"] = "object"
			}
			if params["properties"] == nil {
				params["properties"] = map[string]any{}
			}
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
			name := stringValue(decl["name"])
			if name != "" && name[0] >= '0' && name[0] <= '9' {
				decl["name"] = "t_" + name
			}
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
	if len(props) == 0 {
		return ""
	}
	required := map[string]struct{}{}
	for _, raw := range anySlice(schema["required"]) {
		if key := stringValue(raw); key != "" {
			required[key] = struct{}{}
		}
	}
	parts := []string{}
	for key, rawProp := range props {
		prop, _ := rawProp.(map[string]any)
		typ := defaultStringValue(prop["type"], "unknown")
		if _, ok := required[key]; ok {
			typ += " REQUIRED"
		}
		parts = append(parts, key+": "+typ)
	}
	return strings.Join(parts, ", ")
}

func (p googleCodeAssistProvider) normalizeAntigravityContents(ctx context.Context, payload map[string]any, model, sessionID string) {
	contents, _ := payload["contents"].([]any)
	for _, rawContent := range contents {
		content, _ := rawContent.(map[string]any)
		strictSignatures := providerConfigBool(p.registry, model, p.name, "strict_thought_signatures")
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
				if signature == "" || len(signature) < 50 {
					if cached := p.getCachedSignature(ctx, model, sessionID, thoughtText); cached != "" {
						signature = cached
						part["thoughtSignature"] = cached
					}
				}
				if strictSignatures {
					if len(signature) > 50 {
						p.cacheSignature(ctx, model, sessionID, thoughtText, signature)
						currentThoughtSignature = signature
					} else {
						continue
					}
				} else {
					if signature != "" {
						currentThoughtSignature = signature
						filtered = append(filtered, rawPart)
					}
					continue
				}
			}
			if part["functionCall"] != nil {
				fn, _ := part["functionCall"].(map[string]any)
				if fn["id"] == nil {
					fn["id"] = randomID(stringValue(fn["name"]))
				}
				if providerConfigBool(p.registry, model, p.name, "inject_thought_signature") && part["thoughtSignature"] == nil {
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
					fn["id"] = randomID(stringValue(fn["name"]))
				}
			}
			filtered = append(filtered, rawPart)
		}
		content["parts"] = filtered
	}
	if providerConfigBool(p.registry, model, p.name, "sanitize_tool_blocks") {
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

func (p googleCodeAssistProvider) ensureThinkingModelConfig(payload map[string]any, model string) {
	if !providerConfigBool(p.registry, model, p.name, "thinking_model") {
		return
	}
	generation, _ := payload["generationConfig"].(map[string]any)
	if generation == nil {
		generation = map[string]any{}
		payload["generationConfig"] = generation
	}
	thinking, _ := generation["thinkingConfig"].(map[string]any)
	if thinking == nil {
		thinking = map[string]any{}
		generation["thinkingConfig"] = thinking
	}
	if thinking["include_thoughts"] == nil && thinking["includeThoughts"] == nil {
		thinking["include_thoughts"] = true
	}
	if thinking["thinking_budget"] == nil && thinking["thinkingBudget"] == nil {
		thinking["thinking_budget"] = 16384
	}
	if maxTokens := numberFromAny(generation["maxOutputTokens"]); maxTokens == 0 || maxTokens <= 16384 {
		generation["maxOutputTokens"] = 64000
	}
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
	for _, endpoint := range loadEndpoints {
		payload, _ := json.Marshal(map[string]any{"cloudaicompanionProject": nil, "metadata": map[string]any{"ideType": "IDE_UNSPECIFIED", "platform": "PLATFORM_UNSPECIFIED", "pluginType": "GEMINI"}})
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint+"/v1internal:loadCodeAssist", bytes.NewReader(payload))
		if err != nil {
			continue
		}
		p.setGoogleHeaders(req, accessToken, false)
		resp, err := client.Do(req)
		if err != nil || resp == nil {
			continue
		}
		var data map[string]any
		if resp.StatusCode >= 200 && resp.StatusCode < 300 {
			_ = json.NewDecoder(resp.Body).Decode(&data)
		}
		_ = resp.Body.Close()
		if len(data) == 0 {
			continue
		}
		if project := extractGoogleProjectID(data); project != "" {
			info.projectID = project
		}
		if tier := extractGoogleTier(data); tier != "" {
			info.tier = tier
		}
		if info.projectID != "" {
			break
		}
	}
	if info.projectID == "" {
		if onboard := p.onboardUser(ctx, client, accessToken, info.tier); onboard.projectID != "" {
			info.projectID = onboard.projectID
			info.tier = onboard.tier
		}
	}
	info.email = p.fetchGoogleEmail(ctx, client, accessToken)
	return info
}

func (p googleCodeAssistProvider) onboardUser(ctx context.Context, client *http.Client, accessToken, tier string) googleCodeAssistAccountInfo {
	if tier == "" {
		tier = "free-tier"
	}
	onboardEndpoints := p.onboardEndpoints
	if len(onboardEndpoints) == 0 {
		onboardEndpoints = []string{p.endpoint, "https://cloudcode-pa.googleapis.com"}
	}
	payload, _ := json.Marshal(map[string]any{"tierId": tier, "metadata": map[string]any{"ideType": "IDE_UNSPECIFIED", "platform": "PLATFORM_UNSPECIFIED", "pluginType": "GEMINI"}})
	for _, endpoint := range onboardEndpoints {
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint+"/v1internal:onboardUser", bytes.NewReader(payload))
		if err != nil {
			continue
		}
		p.setGoogleHeaders(req, accessToken, false)
		resp, err := client.Do(req)
		if err != nil || resp == nil {
			continue
		}
		var data map[string]any
		if resp.StatusCode >= 200 && resp.StatusCode < 300 {
			_ = json.NewDecoder(resp.Body).Decode(&data)
		}
		_ = resp.Body.Close()
		if response, ok := data["response"].(map[string]any); ok {
			data = response
		}
		if project := extractGoogleProjectID(data); project != "" {
			return googleCodeAssistAccountInfo{projectID: project, tier: tier}
		}
	}
	return googleCodeAssistAccountInfo{}
}

func (p googleCodeAssistProvider) fetchGoogleEmail(ctx context.Context, client *http.Client, accessToken string) string {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://www.googleapis.com/oauth2/v2/userinfo", nil)
	if err != nil {
		return ""
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(accessToken))
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
		return value
	}
	if tier, ok := data["currentTier"].(map[string]any); ok {
		if id := stringValue(tier["id"]); id != "" {
			return id
		}
		return stringValue(tier["name"])
	}
	return ""
}

func (p googleCodeAssistProvider) setGoogleHeaders(req *http.Request, accessToken string, stream bool) {
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(accessToken))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", map[bool]string{true: "text/event-stream", false: "application/json"}[stream])
	if p.userAgent != "" {
		req.Header.Set("User-Agent", p.userAgent)
	}
	if p.apiClient != "" {
		req.Header.Set("X-Goog-Api-Client", p.apiClient)
	}
	if p.clientMetadata != "" {
		req.Header.Set("Client-Metadata", p.clientMetadata)
	}
}

func (p googleCodeAssistProvider) applyThinkingConfig(payload map[string]any, model, effort string, budget int) {
	if isImageGenerationModel(p.registry, model) {
		return
	}
	config := map[string]any{}
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
	for _, raw := range messages {
		msg, _ := raw.(map[string]any)
		role := stringValue(msg["role"])
		parts := openAIContentToGeminiParts(msg["content"])
		if role == "system" || role == "developer" {
			systemParts = append(systemParts, parts...)
			continue
		}
		geminiRole := "user"
		if role == "assistant" {
			geminiRole = "model"
		}
		contents = append(contents, map[string]any{"role": geminiRole, "parts": parts})
	}
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
	if len(generation) > 0 {
		payload["generationConfig"] = generation
	}
	if tools := geminiTools(body["tools"]); len(tools) > 0 {
		payload["tools"] = []any{map[string]any{"functionDeclarations": tools}}
	}
	payload["safetySettings"] = []any{
		map[string]any{"category": "HARM_CATEGORY_HARASSMENT", "threshold": "OFF"},
		map[string]any{"category": "HARM_CATEGORY_HATE_SPEECH", "threshold": "OFF"},
		map[string]any{"category": "HARM_CATEGORY_SEXUALLY_EXPLICIT", "threshold": "OFF"},
		map[string]any{"category": "HARM_CATEGORY_DANGEROUS_CONTENT", "threshold": "OFF"},
	}
	return payload
}

const antigravitySystemInstruction = "You are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team working on Advanced Agentic Coding.You are pair programming with a USER to solve their coding task. The task may require creating a new codebase, modifying or debugging an existing codebase, or simply answering a question.**Absolute paths only****Proactiveness**"

func (p googleCodeAssistProvider) applyAntigravitySystemInstruction(payload map[string]any, model string) {
	if isImageGenerationModel(p.registry, model) {
		return
	}
	if !providerConfigBool(p.registry, model, p.name, "system_instruction") {
		return
	}
	parts := []any{map[string]any{"text": antigravitySystemInstruction}}
	if existing, ok := payload["systemInstruction"].(map[string]any); ok {
		if existingParts, ok := existing["parts"].([]any); ok {
			parts = append(parts, existingParts...)
		}
	}
	payload["systemInstruction"] = map[string]any{"role": "user", "parts": parts}
}

func openAIContentToGeminiParts(content any) []any {
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
			if part := dataURIToGeminiPart(stringValue(imageURL["url"])); part != nil {
				parts = append(parts, part)
			}
		}
	}
	if len(parts) == 0 {
		parts = append(parts, map[string]any{"text": contentToText(content)})
	}
	return parts
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
		out = append(out, map[string]any{"name": name, "description": defaultStringValue(fn["description"], ""), "parameters": params})
	}
	return out
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

func (p googleCodeAssistProvider) geminiSSEToOpenAISSEReader(ctx context.Context, source io.Reader, model string, includeReasoning bool, sessionID string) io.Reader {
	reader, writer := io.Pipe()
	go func() {
		completionID := randomID("chatcmpl")
		scanner := bufio.NewScanner(source)
		scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
		sentRole := false
		writeChunk := func(delta map[string]any, finish any) {
			chunk := map[string]any{"id": completionID, "object": "chat.completion.chunk", "created": time.Now().Unix(), "model": model, "choices": []any{map[string]any{"index": 0, "delta": delta, "finish_reason": finish}}}
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
			for _, delta := range geminiDeltas(response, includeReasoning) {
				if !sentRole {
					writeChunk(map[string]any{"role": "assistant", "content": ""}, nil)
					sentRole = true
				}
				writeChunk(delta, nil)
			}
		}
		writeChunk(map[string]any{}, "stop")
		_, _ = writer.Write([]byte("data: [DONE]\n\n"))
		_ = writer.Close()
	}()
	return reader
}

func geminiToOpenAICompletion(response map[string]any, model string, includeReasoning bool) map[string]any {
	content := ""
	reasoning := ""
	toolCalls := []any{}
	for _, delta := range geminiDeltas(response, includeReasoning) {
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
		message["tool_calls"] = toolCalls
		finish = "tool_calls"
	}
	return map[string]any{"id": randomID("chatcmpl"), "object": "chat.completion", "created": time.Now().Unix(), "model": model, "choices": []any{map[string]any{"index": 0, "message": message, "finish_reason": finish}}, "usage": map[string]any{"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}}
}

func (p googleCodeAssistProvider) geminiStreamToOpenAICompletion(ctx context.Context, source io.Reader, model string, includeReasoning bool, sessionID string) map[string]any {
	content := ""
	reasoning := ""
	toolCalls := []any{}
	var usage map[string]any
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
		for _, delta := range geminiDeltas(response, includeReasoning) {
			content += stringValue(delta["content"])
			reasoning += stringValue(delta["reasoning_content"])
			if calls, ok := delta["tool_calls"].([]any); ok {
				toolCalls = append(toolCalls, calls...)
			}
		}
		if rawUsage, ok := response["usageMetadata"].(map[string]any); ok {
			usage = map[string]any{"prompt_tokens": numberFromAny(rawUsage["promptTokenCount"]), "completion_tokens": numberFromAny(rawUsage["candidatesTokenCount"]), "total_tokens": numberFromAny(rawUsage["totalTokenCount"])}
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
		message["tool_calls"] = toolCalls
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

func geminiDeltas(response map[string]any, includeReasoning bool) []map[string]any {
	deltas := []map[string]any{}
	candidates, _ := response["candidates"].([]any)
	for _, rawCandidate := range candidates {
		candidate, _ := rawCandidate.(map[string]any)
		content, _ := candidate["content"].(map[string]any)
		parts, _ := content["parts"].([]any)
		toolIndex := 0
		for _, rawPart := range parts {
			part, _ := rawPart.(map[string]any)
			if fn, ok := part["functionCall"].(map[string]any); ok {
				name := stringValue(fn["name"])
				args := fn["args"]
				encodedArgs, _ := json.Marshal(args)
				if len(encodedArgs) == 0 || string(encodedArgs) == "null" {
					encodedArgs = []byte("{}")
				}
				id := stringValue(fn["id"])
				if id == "" {
					id = randomID("call")
				}
				deltas = append(deltas, map[string]any{"tool_calls": []any{map[string]any{"index": toolIndex, "id": id, "type": "function", "function": map[string]any{"name": name, "arguments": string(encodedArgs)}}}})
				toolIndex++
				continue
			}
			text := stringValue(part["text"])
			if text == "" {
				continue
			}
			if includeReasoning && part["thought"] == true {
				deltas = append(deltas, map[string]any{"reasoning_content": text})
			} else {
				deltas = append(deltas, map[string]any{"content": text})
			}
		}
	}
	return deltas
}
