package providers

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/user"
	"runtime"
	"strings"
	"sync"
	"time"

	appdb "github.com/opendum/opendum/apps/proxy/internal/db"
	"github.com/opendum/opendum/apps/proxy/internal/models"
)

const (
	mimoCodeBootstrapURL   = "https://api.xiaomimimo.com/api/free-ai/bootstrap"
	mimoCodeChatURL        = "https://api.xiaomimimo.com/api/free-ai/openai/chat"
	mimoCodeSource         = "mimocode-cli-free"
	mimoCodeSystemMarker   = "You are MiMoCode, an interactive CLI tool that helps users with software engineering tasks."
	mimoCodeJWTFallbackTTL = 3000 * time.Second
	mimoCodeJWTBuffer      = 5 * time.Minute
)

const (
	mimoCodeSessionPrefix = "ses_"
	mimoCodeSessionLen    = 24
)

var (
	mimoCodeJWTMu       sync.RWMutex
	mimoCodeCachedJWT   string
	mimoCodeJWTExpires  time.Time
	mimoCodeSessionOnce = sync.OnceValue(generateMimoCodeSessionID)
)

var supportedMimoCode = set("model", "messages", "temperature", "top_p", "max_tokens", "max_completion_tokens", "stream", "stream_options", "tools", "tool_choice", "parallel_tool_calls", "presence_penalty", "frequency_penalty", "n", "stop", "seed", "response_format", "reasoning", "reasoning_effort")

func generateMimoCodeFingerprint() string {
	hostname, _ := os.Hostname()
	if hostname == "" {
		hostname = "unknown-host"
	}
	username := "unknown-user"
	if u, err := user.Current(); err == nil && u != nil && u.Username != "" {
		username = u.Username
	}
	seed := fmt.Sprintf("%s|%s|%s|%s", hostname, runtime.GOOS, runtime.GOARCH, username)
	sum := sha256.Sum256([]byte(seed))
	return hex.EncodeToString(sum[:])
}

func generateMimoCodeSessionID() string {
	id := mimoCodeSessionPrefix
	const chars = "abcdefghijklmnopqrstuvwxyz0123456789"
	buf := make([]byte, mimoCodeSessionLen)
	if _, err := rand.Read(buf); err != nil {
		return id + strings.Repeat("0", mimoCodeSessionLen)
	}
	for _, b := range buf {
		id += string(chars[int(b)%len(chars)])
	}
	return id
}

func parseMimoCodeJWTExp(jwt string) time.Time {
	parts := strings.Split(jwt, ".")
	if len(parts) < 2 {
		return time.Time{}
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return time.Time{}
	}
	var claims struct {
		Exp int64 `json:"exp"`
	}
	if err := json.Unmarshal(payload, &claims); err != nil || claims.Exp == 0 {
		return time.Time{}
	}
	return time.Unix(claims.Exp, 0)
}

func resetMimoCodeJWT() {
	mimoCodeJWTMu.Lock()
	mimoCodeCachedJWT = ""
	mimoCodeJWTExpires = time.Time{}
	mimoCodeJWTMu.Unlock()
}

func bootstrapMimoCodeJWT(ctx context.Context, client *http.Client) (string, error) {
	mimoCodeJWTMu.RLock()
	cached := mimoCodeCachedJWT
	expires := mimoCodeJWTExpires
	mimoCodeJWTMu.RUnlock()
	if cached != "" && time.Now().Before(expires.Add(-mimoCodeJWTBuffer)) {
		return cached, nil
	}

	fingerprint := generateMimoCodeFingerprint()
	body, err := json.Marshal(map[string]any{"client": fingerprint})
	if err != nil {
		return "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, mimoCodeBootstrapURL, strings.NewReader(string(body)))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		data, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("mimo_code bootstrap failed: %d %s", resp.StatusCode, strings.TrimSpace(string(data)))
	}
	var payload struct {
		JWT string `json:"jwt"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return "", err
	}
	if strings.TrimSpace(payload.JWT) == "" {
		return "", fmt.Errorf("mimo_code bootstrap returned no jwt")
	}
	expiresAt := parseMimoCodeJWTExp(payload.JWT)
	if expiresAt.IsZero() {
		expiresAt = time.Now().Add(mimoCodeJWTFallbackTTL)
	}
	mimoCodeJWTMu.Lock()
	mimoCodeCachedJWT = payload.JWT
	mimoCodeJWTExpires = expiresAt
	mimoCodeJWTMu.Unlock()
	return payload.JWT, nil
}

func injectMimoCodeSystemMarker(body map[string]any) {
	messages, ok := body["messages"].([]any)
	if !ok {
		return
	}
	for _, m := range messages {
		mm, ok := m.(map[string]any)
		if !ok {
			continue
		}
		role, _ := mm["role"].(string)
		content, _ := mm["content"].(string)
		if role == "system" && strings.Contains(content, mimoCodeSystemMarker) {
			return
		}
	}
	body["messages"] = append([]any{map[string]any{"role": "system", "content": mimoCodeSystemMarker}}, messages...)
}

type mimoCodeProvider struct {
	registry *models.Registry
}

func (p mimoCodeProvider) Authless() bool { return true }

func (p mimoCodeProvider) MakeRequest(ctx context.Context, client *http.Client, _ string, _ appdb.ProviderAccount, body map[string]any, stream bool) (*http.Response, error) {
	payload := map[string]any{}
	for key, value := range body {
		if _, ok := supportedMimoCode[key]; ok && value != nil {
			payload[key] = value
		}
	}
	model := stringValue(body["model"])
	if strings.HasPrefix(model, "mimo_code/") {
		model = strings.TrimPrefix(model, "mimo_code/")
	}
	if p.registry != nil {
		model = p.registry.UpstreamModelName(model, "mimo_code")
	}
	payload["model"] = model
	payload["stream"] = stream
	injectMimoCodeSystemMarker(payload)

	headers := map[string]string{
		"X-Mimo-Source":      mimoCodeSource,
		"x-session-affinity": mimoCodeSessionOnce(),
	}

	jwt, err := bootstrapMimoCodeJWT(ctx, client)
	if err != nil {
		return nil, err
	}
	resp, err := postJSONWithHeaders(ctx, client, mimoCodeChatURL, jwt, payload, stream, headers)
	if err != nil {
		return resp, err
	}
	if resp.StatusCode != http.StatusUnauthorized && resp.StatusCode != http.StatusForbidden {
		return resp, nil
	}

	_ = resp.Body.Close()
	resetMimoCodeJWT()
	jwt2, err := bootstrapMimoCodeJWT(ctx, client)
	if err != nil {
		return nil, err
	}
	return postJSONWithHeaders(ctx, client, mimoCodeChatURL, jwt2, payload, stream, headers)
}
