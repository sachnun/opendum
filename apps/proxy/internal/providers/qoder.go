package providers

import (
	"bufio"
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/md5"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	appdb "github.com/opendum/opendum/apps/proxy/internal/db"
	"github.com/opendum/opendum/apps/proxy/internal/models"
)

// Qoder separates identity (openapi.qoder.sh, bearer device token) from
// inference (api3.qoder.sh, COSY-signed agent_chat_generation). The
// signing scheme and request envelope were reverse-engineered from the
// official qodercli bundle; they require no native code.
const (
	qoderOpenAPIBase       = "https://openapi.qoder.sh"
	qoderInferenceBase     = "https://api3.qoder.sh"
	qoderInferencePath     = "/algo/api/v2/service/pro/sse/agent_chat_generation"
	qoderInferenceQuery    = "?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1"
	qoderDeviceRefreshPath = "/api/v1/deviceToken/refresh"
	qoderUserInfoPath      = "/api/v1/userinfo"

	qoderIDEVersion    = "1.0.0"
	qoderClientType    = "5"
	qoderMachineType   = "5"
	qoderMachineOS     = "x86_64_windows"
	qoderDataPolicy    = "disagree"
	qoderLoginVersion  = "v2"
	qoderDefaultModel  = "qmodel_latest"
	qoderRefreshBuffer = 5 * time.Minute
	qoderSessionType   = "qodercli"
	qoderAgentID       = "agent_common"
	qoderTaskID        = "common"
)

// qoderStdAlphabet mirrors the standard base64 alphabet; qoderCustomAlphabet
// is Qoder's substitution table. The body encoder swaps every base64 char
// for its counterpart in the custom table so the gateway treats the payload
// as opaque (the WAF bypass referenced in the bundle as Encode=1).
var qoderStdAlphabet = []byte("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/")

var qoderCustomAlphabet = []byte("_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!")

// qoderRSAPublicKey encrypts the AES key so the gateway can recover it
// without the proxy ever sharing the symmetric secret in cleartext.
var qoderRSAPublicKey = mustParseQoderRSAPublicKey()

type qoderProvider struct {
	registry *models.Registry
}

func (p qoderProvider) RefreshBuffer() time.Duration { return qoderRefreshBuffer }

func (p qoderProvider) RefreshCredentials(ctx context.Context, client *http.Client, refreshToken string, _ appdb.ProviderAccount) (RefreshedCredentials, error) {
	body, _ := json.Marshal(map[string]string{"refresh_token": strings.TrimSpace(refreshToken)})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, qoderOpenAPIBase+qoderDeviceRefreshPath, bytes.NewReader(body))
	if err != nil {
		return RefreshedCredentials{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return RefreshedCredentials{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return RefreshedCredentials{}, fmt.Errorf("qoder token refresh failed: %d %s", resp.StatusCode, readLimit(resp.Body, 1<<20))
	}
	var token struct {
		DeviceToken  string `json:"device_token"`
		Token        string `json:"token"`
		RefreshToken string `json:"refresh_token"`
		ExpiresIn    int64  `json:"expires_in"`
		ExpiresAt    string `json:"expires_at"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&token); err != nil {
		return RefreshedCredentials{}, err
	}
	accessToken := token.DeviceToken
	if accessToken == "" {
		accessToken = token.Token
	}
	if accessToken == "" {
		return RefreshedCredentials{}, fmt.Errorf("qoder token refresh returned empty token")
	}
	if token.RefreshToken == "" {
		token.RefreshToken = refreshToken
	}
	expiresAt := parseQoderExpiry(token.ExpiresAt, token.ExpiresIn, 86400)
	return RefreshedCredentials{AccessToken: accessToken, RefreshToken: token.RefreshToken, ExpiresAt: expiresAt}, nil
}

func (p qoderProvider) MakeRequest(ctx context.Context, client *http.Client, accessToken string, account appdb.ProviderAccount, body map[string]any, stream bool) (*http.Response, error) {
	uid, machineID := splitQoderAccountID(account.AccountID)
	if uid == "" {
		// Fall back to fetching the user id from /userinfo so accounts saved
		// before the packed identifier shipped still work.
		resolved, err := fetchQoderUserID(ctx, client, accessToken)
		if err != nil {
			return nil, err
		}
		uid = resolved
	}
	if machineID == "" {
		machineID = uid
	}

	modelName := p.resolveModel(stringValue(body["model"]))
	isReasoning := p.registry != nil && p.registry.IsReasoningModel(stringValue(body["model"]))

	messages, _ := body["messages"].([]any)
	systemText, normalizedMessages, lastUserText := qoderTransformMessages(messages)
	if lastUserText == "" {
		lastUserText = "ping"
	}

	modelConfig := map[string]any{
		"key":               modelName,
		"is_reasoning":      isReasoning,
		"max_output_tokens": 32768,
		"source":            "system",
	}
	recordID := randomQoderID()
	sessionID := randomQoderID()
	maxTokens := qoderMaxTokens(body)

	reqBody := map[string]any{
		"request_id":       randomQoderID(),
		"request_set_id":   recordID,
		"chat_record_id":   recordID,
		"session_id":       sessionID,
		"stream":           true,
		"chat_task":        "FREE_INPUT",
		"is_reply":         true,
		"is_retry":         false,
		"source":           1,
		"version":          "3",
		"session_type":     qoderSessionType,
		"agent_id":         qoderAgentID,
		"task_id":          qoderTaskID,
		"code_language":    "",
		"chat_prompt":      "",
		"image_urls":       nil,
		"aliyun_user_type": "",
		"system":           systemText,
		"messages":         normalizedMessages,
		"tools":            qoderTools(body),
		"parameters":       map[string]any{"max_tokens": maxTokens},
		"chat_context": map[string]any{
			"chatPrompt": "",
			"imageUrls":  nil,
			"extra": map[string]any{
				"context":         []any{},
				"modelConfig":     map[string]any{"key": modelName, "is_reasoning": isReasoning},
				"originalContent": lastUserText,
			},
			"features": []any{},
			"text":     lastUserText,
		},
		"model_config": modelConfig,
		"business": map[string]any{
			"product":  "cli",
			"version":  qoderIDEVersion,
			"type":     "agent",
			"stage":    "start",
			"id":       randomQoderID(),
			"name":     qoderTruncate(lastUserText, 30),
			"begin_at": time.Now().UnixMilli(),
		},
	}

	plaintext, err := json.Marshal(reqBody)
	if err != nil {
		return nil, err
	}
	encoded := qoderEncodeBody(plaintext)
	encodedBytes := []byte(encoded)

	requestURL := qoderInferenceBase + qoderInferencePath + qoderInferenceQuery
	headers := buildQoderAuthHeaders(encodedBytes, requestURL, uid, machineID, accessToken)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, requestURL, bytes.NewReader(encodedBytes))
	if err != nil {
		return nil, err
	}
	for key, value := range headers {
		req.Header.Set(key, value)
	}

	resp, err := client.Do(req)
	if err != nil || resp == nil || resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return resp, err
	}
	MarkUpstreamResponseStarted(ctx)

	if stream {
		return sseResponse(qoderSSEToChatSSEReader(resp.Body, modelName), resp.Body), nil
	}
	completion := qoderStreamToCompletion(resp.Body, modelName)
	_ = resp.Body.Close()
	return jsonResponse(http.StatusOK, completion), nil
}

func (p qoderProvider) resolveModel(model string) string {
	model = lastModelSegment(model)
	if p.registry != nil {
		return p.registry.UpstreamModelName(model, "qoder")
	}
	if model == "" {
		return qoderDefaultModel
	}
	return model
}

// --- message / payload helpers ---

func qoderTransformMessages(messages []any) (string, []any, string) {
	normalized := make([]any, 0, len(messages))
	systemText := ""
	lastUserText := ""
	for _, raw := range messages {
		msg, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		role := stringValue(msg["role"])
		content := qoderMessageContent(msg["content"])
		switch role {
		case "system":
			if systemText == "" {
				systemText = content
			}
			continue
		case "user", "assistant":
			normalized = append(normalized, map[string]any{"role": role, "content": content})
			if role == "user" {
				lastUserText = content
			}
		}
	}
	if lastUserText == "" {
		for i := len(normalized) - 1; i >= 0; i-- {
			if msg, ok := normalized[i].(map[string]any); ok && stringValue(msg["role"]) == "user" {
				lastUserText = stringValue(msg["content"])
				break
			}
		}
	}
	return systemText, normalized, lastUserText
}

func qoderMessageContent(value any) string {
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

func qoderTools(body map[string]any) []any {
	tools, _ := body["tools"].([]any)
	if len(tools) == 0 {
		return []any{}
	}
	return tools
}

func qoderMaxTokens(body map[string]any) int {
	if v := numberFromAny(body["max_tokens"]); v > 0 {
		return v
	}
	if v := numberFromAny(body["max_completion_tokens"]); v > 0 {
		return v
	}
	return 32768
}

func qoderTruncate(value string, limit int) string {
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return string(runes[:limit])
}

// --- COSY signing ---

func buildQoderAuthHeaders(body []byte, requestURL, uid, machineID, authToken string) map[string]string {
	aesKey := randomQoderAESKey()
	infoB64 := qoderAESEncryptCBC(
		fmt.Sprintf(`{"uid":%q,"security_oauth_token":%q,"name":"","aid":"","email":""}`, uid, authToken),
		aesKey,
	)
	cosyKey := qoderRSAEncrypt(aesKey)
	timestamp := fmt.Sprintf("%d", time.Now().Unix())
	requestID := randomQoderID()

	cosyPayload, _ := json.Marshal(map[string]string{
		"version":     "v1",
		"requestId":   requestID,
		"info":        infoB64,
		"cosyVersion": qoderIDEVersion,
		"ideVersion":  "",
	})
	payloadB64 := base64.StdEncoding.EncodeToString(cosyPayload)

	sigPath := qoderSigPath(requestURL)
	bodyStr := string(body)
	sigInput := payloadB64 + "\n" + cosyKey + "\n" + timestamp + "\n" + bodyStr + "\n" + sigPath
	sig := qoderMD5Hex(sigInput)
	bodyHash := qoderMD5Hex(bodyStr)

	return map[string]string{
		"Authorization":          "Bearer COSY." + payloadB64 + "." + sig,
		"Cosy-Key":               cosyKey,
		"Cosy-User":              uid,
		"Cosy-Date":              timestamp,
		"Cosy-Version":           qoderIDEVersion,
		"Cosy-Machineid":         machineID,
		"Cosy-Machinetoken":      machineID,
		"Cosy-Machinetype":       qoderMachineType,
		"Cosy-Machineos":         qoderMachineOS,
		"Cosy-Clienttype":        qoderClientType,
		"Cosy-Clientip":          "127.0.0.1",
		"Cosy-Bodyhash":          bodyHash,
		"Cosy-Bodylength":        fmt.Sprintf("%d", len(body)),
		"Cosy-Sigpath":           sigPath,
		"Cosy-Data-Policy":       qoderDataPolicy,
		"Cosy-Organization-Id":   "",
		"Cosy-Organization-Tags": "",
		"Login-Version":          qoderLoginVersion,
		"X-Request-Id":           randomQoderID(),
		"Content-Type":           "application/json",
		"Accept":                 "text/event-stream",
	}
}

func qoderSigPath(requestURL string) string {
	path := requestURL
	if idx := strings.Index(requestURL, "://"); idx >= 0 {
		path = requestURL[idx+3:]
		if slash := strings.Index(path, "/"); slash >= 0 {
			path = path[slash:]
		}
	}
	if i := strings.Index(path, "?"); i >= 0 {
		path = path[:i]
	}
	return strings.TrimPrefix(path, "/algo")
}

func qoderAESEncryptCBC(plaintext, keyStr string) string {
	key := []byte(keyStr)
	block, err := aes.NewCipher(key)
	if err != nil {
		return ""
	}
	// qodercli uses the 16-byte key as both key and IV (AES-128-CBC).
	ciphertext := make([]byte, len(plaintext)+block.BlockSize()-(len(plaintext)%block.BlockSize()))
	mode := cipher.NewCBCEncrypter(block, key)
	mode.CryptBlocks(ciphertext, qoderPKCS7Pad([]byte(plaintext), block.BlockSize()))
	return base64.StdEncoding.EncodeToString(ciphertext[:((len(plaintext) + block.BlockSize() - 1) / block.BlockSize() * block.BlockSize())])
}

func qoderPKCS7Pad(data []byte, blockSize int) []byte {
	pad := blockSize - len(data)%blockSize
	out := make([]byte, len(data)+pad)
	copy(out, data)
	for i := len(data); i < len(out); i++ {
		out[i] = byte(pad)
	}
	return out
}

func qoderRSAEncrypt(data string) string {
	if qoderRSAPublicKey == nil {
		return ""
	}
	encrypted, err := rsa.EncryptPKCS1v15(rand.Reader, qoderRSAPublicKey, []byte(data))
	if err != nil {
		return ""
	}
	return base64.StdEncoding.EncodeToString(encrypted)
}

func qoderMD5Hex(value string) string {
	sum := md5.Sum([]byte(value))
	return hex.EncodeToString(sum[:])
}

// qoderEncodeBody mirrors qodercli's WAF-bypass body encoder: base64 encode,
// rotate the three thirds, then substitute each char through the custom
// alphabet (with '=' mapped to '$').
func qoderEncodeBody(plaintext []byte) string {
	std := base64.StdEncoding.EncodeToString(plaintext)
	n := len(std)
	a := n / 3
	rearranged := std[n-a:] + std[a:n-a] + std[:a]
	table := make(map[byte]byte, len(qoderStdAlphabet))
	for i, c := range qoderStdAlphabet {
		table[c] = qoderCustomAlphabet[i]
	}
	out := make([]byte, 0, n)
	for i := 0; i < n; i++ {
		c := rearranged[i]
		if c == '=' {
			out = append(out, '$')
			continue
		}
		if mapped, ok := table[c]; ok {
			out = append(out, mapped)
			continue
		}
		out = append(out, c)
	}
	return string(out)
}

// --- response transform ---

// qoderSSEToChatSSEReader unwraps the nested envelope Qoder streams:
// `data:{"body":"<openai chunk json>","statusCode":"OK"}`. Each inner body is
// re-emitted as a standard `data:<body>` SSE event so downstream readers see
// an OpenAI-compatible stream.
func qoderSSEToChatSSEReader(body io.Reader, model string) io.Reader {
	pr, pw := io.Pipe()
	go func() {
		defer pw.Close()
		scanner := bufio.NewScanner(body)
		scanner.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
		finished := false
		for scanner.Scan() {
			line := strings.TrimSpace(scanner.Text())
			if line == "" || !strings.HasPrefix(line, "data:") {
				continue
			}
			payload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
			if payload == "" || payload == "[DONE]" {
				continue
			}
			inner := qoderExtractBody(payload)
			if inner == "" {
				continue
			}
			if strings.Contains(inner, `"event":`) || strings.Contains(inner, `event:finish`) {
				// The finish envelope carries timing metadata, not completion
				// data; keep reading until the stream is closed.
			}
			if _, err := fmt.Fprintf(pw, "data: %s\n\n", inner); err != nil {
				return
			}
			if !finished {
				_ = finished
			}
		}
		_, _ = fmt.Fprintf(pw, "data: [DONE]\n\n")
	}()
	return pr
}

func qoderExtractBody(payload string) string {
	var envelope struct {
		Body       json.RawMessage `json:"body"`
		StatusCode string          `json:"statusCode"`
	}
	if err := json.Unmarshal([]byte(payload), &envelope); err != nil {
		return payload
	}
	if len(envelope.Body) == 0 && envelope.StatusCode != "" {
		return ""
	}
	if len(envelope.Body) == 0 {
		return ""
	}
	// body is a JSON string containing the inner OpenAI chunk JSON.
	var inner string
	if err := json.Unmarshal(envelope.Body, &inner); err == nil {
		return inner
	}
	return string(envelope.Body)
}

func qoderStreamToCompletion(body io.Reader, model string) map[string]any {
	reader := qoderSSEToChatSSEReader(body, model)
	data, _ := io.ReadAll(reader)
	events := parseSSEDataLines(string(data))
	completion := map[string]any{"output": []any{}, "usage": map[string]any{}}
	messageContent := ""
	toolCalls := []any{}
	currentTool := map[string]any{}
	for _, event := range events {
		typ := stringValue(event["type"])
		if typ == "" {
			if choices, ok := event["choices"].([]any); ok && len(choices) > 0 {
				if choice, ok := choices[0].(map[string]any); ok {
					if delta, ok := choice["delta"].(map[string]any); ok {
						if c, ok := delta["content"].(string); ok {
							messageContent += c
						}
						if rc, ok := delta["reasoning_content"].(string); ok && rc != "" {
							messageContent += rc
						}
						if tc, ok := delta["tool_calls"].([]any); ok {
							toolCalls = append(toolCalls, tc...)
						}
					}
					if msg, ok := choice["message"].(map[string]any); ok {
						if c, ok := msg["content"].(string); ok && c != "" {
							messageContent += c
						}
					}
				}
			}
		}
		switch typ {
		case "response.output_item.added":
			item, _ := event["item"].(map[string]any)
			if item["type"] == "function_call" {
				currentTool = map[string]any{"type": "function_call", "id": item["id"], "call_id": item["call_id"], "name": item["name"], "arguments": ""}
			}
		case "response.function_call_arguments.delta":
			if currentTool != nil {
				currentTool["arguments"] = stringValue(currentTool["arguments"]) + stringValue(event["delta"])
			}
		case "response.function_call_arguments.done", "response.output_item.done":
			if currentTool != nil {
				toolCalls = append(toolCalls, currentTool)
				currentTool = nil
			}
		case "response.completed", "response.done":
			resp, _ := event["response"].(map[string]any)
			if resp == nil {
				resp = event
			}
			completion["status"] = resp["status"]
			completion["usage"] = resp["usage"]
		}
	}
	output := []any{}
	if messageContent != "" {
		output = append(output, map[string]any{"type": "message", "content": []any{map[string]any{"type": "output_text", "text": messageContent}}})
	}
	output = append(output, toolCalls...)
	completion["output"] = output
	return responsesJSONToChatCompletion(completion, model)
}

// --- identity / utilities ---

func fetchQoderUserID(ctx context.Context, client *http.Client, accessToken string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, qoderOpenAPIBase+qoderUserInfoPath, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(accessToken))
	req.Header.Set("Accept", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("qoder userinfo failed: %d", resp.StatusCode)
	}
	var user struct {
		ID   string `json:"id"`
		Name string `json:"username"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&user)
	return user.ID, nil
}

func splitQoderAccountID(accountID *string) (string, string) {
	if accountID == nil {
		return "", ""
	}
	value := strings.TrimSpace(*accountID)
	if value == "" {
		return "", ""
	}
	if idx := strings.Index(value, "|"); idx >= 0 {
		return value[:idx], value[idx+1:]
	}
	// Older accounts stored only the machine_id; treat it as both.
	return value, value
}

func parseQoderExpiry(expiresAt string, expiresInSeconds, fallbackSeconds int64) time.Time {
	if expiresAt != "" {
		if parsed, err := time.Parse(time.RFC3339, expiresAt); err == nil {
			return parsed
		}
	}
	if expiresInSeconds > 0 {
		return time.Now().Add(time.Duration(expiresInSeconds) * time.Second)
	}
	return time.Now().Add(time.Duration(fallbackSeconds) * time.Second)
}

func randomQoderID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// randomQoderAESKey mirrors qodercli's aesKey derivation: the hex of a UUID
// truncated to 16 characters. The result is 16 bytes of ASCII (hex digits),
// matching AES-128's key size.
func randomQoderAESKey() string {
	id := randomQoderID()
	return strings.ReplaceAll(id, "-", "")[:16]
}

func mustParseQoderRSAPublicKey() *rsa.PublicKey {
	block, _ := pem.Decode([]byte(`-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`))
	if block == nil {
		return nil
	}
	pub, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return nil
	}
	rsaPub, ok := pub.(*rsa.PublicKey)
	if !ok {
		return nil
	}
	return rsaPub
}
