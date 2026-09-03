package providers

import (
	"os"
	"path/filepath"
	"testing"

	appdb "github.com/opendum/opendum/apps/proxy/internal/db"
)

func TestLoadCustomProviderConfigsEmpty(t *testing.T) {
	t.Setenv("CUSTOM_PROVIDERS", "")
	t.Setenv("CUSTOM_PROVIDERS_FILE", "")
	configs, err := LoadCustomProviderConfigs()
	if err != nil {
		t.Fatalf("LoadCustomProviderConfigs() error = %v", err)
	}
	if configs != nil {
		t.Fatalf("configs = %#v, want nil", configs)
	}
}

func TestLoadCustomProviderConfigsEnv(t *testing.T) {
	t.Setenv("CUSTOM_PROVIDERS_FILE", "")
	t.Setenv("CUSTOM_PROVIDERS", `[
		{"name": "My-vLLM", "baseUrl": "https://vllm.internal/v1/", "extraHeaders": {"x-tenant": "opendum"}},
		{"name": "local_api", "baseUrl": "http://localhost:11434", "supportedParams": ["model", "messages", "stream"]}
	]`)
	configs, err := LoadCustomProviderConfigs()
	if err != nil {
		t.Fatalf("LoadCustomProviderConfigs() error = %v", err)
	}
	if len(configs) != 2 {
		t.Fatalf("len(configs) = %d, want 2", len(configs))
	}
	first := configs[0]
	if first.Name != "my-vllm" {
		t.Fatalf("Name = %q, want %q", first.Name, "my-vllm")
	}
	if first.BaseURL != "https://vllm.internal/v1" {
		t.Fatalf("BaseURL = %q, want trailing slash trimmed", first.BaseURL)
	}
	if first.TrimPrefix != "my-vllm/" {
		t.Fatalf("TrimPrefix = %q, want %q", first.TrimPrefix, "my-vllm/")
	}
	if first.ExtraHeaders["x-tenant"] != "opendum" {
		t.Fatalf("ExtraHeaders = %#v, want x-tenant header", first.ExtraHeaders)
	}
	second := configs[1]
	if second.TrimPrefix != "local_api/" {
		t.Fatalf("TrimPrefix = %q, want %q", second.TrimPrefix, "local_api/")
	}
	provider := second.provider(nil).(openAICompatibleProvider)
	for _, key := range []string{"model", "messages", "stream"} {
		if _, ok := provider.supportedParams[key]; !ok {
			t.Fatalf("supportedParams missing %q", key)
		}
	}
	if _, ok := provider.supportedParams["tools"]; ok {
		t.Fatalf("supportedParams should not include tools when explicitly set")
	}
}

func TestLoadCustomProviderConfigsFile(t *testing.T) {
	t.Setenv("CUSTOM_PROVIDERS", "")
	path := filepath.Join(t.TempDir(), "providers.json")
	if err := os.WriteFile(path, []byte(`[{"name": "file_provider", "baseUrl": "https://example.com/v1"}]`), 0o600); err != nil {
		t.Fatalf("WriteFile error = %v", err)
	}
	t.Setenv("CUSTOM_PROVIDERS_FILE", path)
	configs, err := LoadCustomProviderConfigs()
	if err != nil {
		t.Fatalf("LoadCustomProviderConfigs() error = %v", err)
	}
	if len(configs) != 1 || configs[0].Name != "file_provider" {
		t.Fatalf("configs = %#v, want single file_provider", configs)
	}
}

func TestLoadCustomProviderConfigsInvalid(t *testing.T) {
	t.Setenv("CUSTOM_PROVIDERS_FILE", "")
	cases := []string{
		`[{"name": "Bad Name!", "baseUrl": "https://example.com"}]`,
		`[{"name": "ok", "baseUrl": "ftp://example.com"}]`,
		`[{"name": "ok", "baseUrl": "https://example.com", "extraHeaders": {"Host": "evil"}}]`,
		`[{"name": "ok", "baseUrl": "https://example.com", "extraHeaders": {"X-Test": "a\r\nb"}}]`,
		`[{"name": "ok", "baseUrl": "https://example.com", "extraHeaders": {"Bad:Name": "v"}}]`,
		`not-json`,
	}
	for _, raw := range cases {
		t.Setenv("CUSTOM_PROVIDERS", raw)
		if _, err := LoadCustomProviderConfigs(); err == nil {
			t.Fatalf("LoadCustomProviderConfigs(%q) error = nil, want error", raw)
		}
	}
}

func TestCompileCustomProviderHooks(t *testing.T) {
	provider := &appdb.CustomProvider{
		Slug:         "my-vllm",
		BaseURL:      "https://vllm.internal/v1",
		ExtraHeaders: map[string]string{"x-tenant": "opendum"},
	}
	rows := []appdb.CustomProviderModel{
		{ModelID: "qwen3-32b", Upstream: "Qwen/Qwen3-32B", Authless: true, CustomFlags: map[string]any{"responses_api": true, "top_p_deprecated": true, "convert_external_images": true}},
		{ModelID: "plain", Upstream: ""},
	}
	compiled := CompileCustomProvider(provider, rows).(openAICompatibleProvider)
	if got := compiled.normalizeModel("my-vllm/qwen3-32b"); got != "qwen3-32b" {
		t.Fatalf("normalizeModel = %q, want qwen3-32b", got)
	}
	if got := compiled.resolveModel("qwen3-32b"); got != "Qwen/Qwen3-32B" {
		t.Fatalf("resolveModel = %q, want upstream", got)
	}
	if got := compiled.resolveModel("plain"); got != "plain" {
		t.Fatalf("resolveModel plain = %q, want passthrough", got)
	}
	if got := compiled.resolveModel("missing"); got != "missing" {
		t.Fatalf("resolveModel missing = %q, want passthrough", got)
	}
	if !compiled.requiresResponsesAPI("qwen3-32b") {
		t.Fatal("requiresResponsesAPI(qwen3-32b) = false, want true")
	}
	if compiled.requiresResponsesAPI("plain") {
		t.Fatal("requiresResponsesAPI(plain) = true, want false")
	}
	if !compiled.convertImages("qwen3-32b") {
		t.Fatal("convertImages(qwen3-32b) = false, want true")
	}
	if !compiled.authlessModel("qwen3-32b") {
		t.Fatal("authlessModel(qwen3-32b) = false, want true")
	}
	if compiled.authlessModel("plain") {
		t.Fatal("authlessModel(plain) = true, want false")
	}
	payload := compiled.buildPayload(map[string]any{"model": "my-vllm/qwen3-32b", "messages": []any{}, "temperature": 0.5, "top_p": 0.9, "unknown_param": 1}, "qwen3-32b", "Qwen/Qwen3-32B", false)
	if payload["model"] != "Qwen/Qwen3-32B" {
		t.Fatalf("payload model = %#v", payload["model"])
	}
	if payload["stream"] != false {
		t.Fatalf("payload stream = %#v", payload["stream"])
	}
	if _, ok := payload["top_p"]; ok {
		t.Fatal("payload includes top_p, want dropped")
	}
	if _, ok := payload["unknown_param"]; ok {
		t.Fatal("payload includes unknown_param, want dropped")
	}
	headers := compiled.extraRequestHeaders(appdb.ProviderAccount{})
	if headers == nil || headers["x-tenant"] != "opendum" {
		t.Fatalf("extraRequestHeaders = %#v, want x-tenant", headers)
	}
}

func TestCustomProviderRegistered(t *testing.T) {
	custom := CustomProviderConfig{Name: "my-vllm", BaseURL: "https://vllm.internal/v1"}
	registry := NewRegistry(nil, nil, nil, custom)
	provider, ok := registry.Get("my-vllm")
	if !ok {
		t.Fatal("custom provider my-vllm missing from registry")
	}
	compat, ok := provider.(openAICompatibleProvider)
	if !ok {
		t.Fatalf("provider type = %T, want openAICompatibleProvider", provider)
	}
	if compat.baseURL != "https://vllm.internal/v1" {
		t.Fatalf("baseURL = %q", compat.baseURL)
	}
	if compat.trimPrefix != "my-vllm/" {
		t.Fatalf("trimPrefix = %q, want %q", compat.trimPrefix, "my-vllm/")
	}
	if len(compat.supportedParams) == 0 {
		t.Fatal("supportedParams empty, want default set")
	}
}

func TestCustomProviderCannotOverrideBuiltin(t *testing.T) {
	custom := CustomProviderConfig{Name: "openrouter", BaseURL: "https://evil.example/v1"}
	registry := NewRegistry(nil, nil, nil, custom)
	provider, ok := registry.Get("openrouter")
	if !ok {
		t.Fatal("openrouter missing from registry")
	}
	compat := provider.(openAICompatibleProvider)
	if compat.baseURL != "https://openrouter.ai/api/v1" {
		t.Fatalf("built-in openrouter baseURL = %q, want original", compat.baseURL)
	}
}

func TestCustomProviderExtraRequestHeaders(t *testing.T) {
	custom := CustomProviderConfig{
		Name:         "my-vllm",
		BaseURL:      "https://vllm.internal/v1",
		ExtraHeaders: map[string]string{"x-tenant": "opendum", "User-Agent": "opendum-gateway/0.2"},
	}
	provider := custom.provider(nil).(openAICompatibleProvider)
	headers := provider.extraRequestHeaders(appdb.ProviderAccount{})
	if headers == nil {
		t.Fatal("extraRequestHeaders() = nil, want headers")
	}
	if headers["x-tenant"] != "opendum" {
		t.Fatalf("x-tenant = %q, want opendum", headers["x-tenant"])
	}
	if headers["User-Agent"] != "opendum-gateway/0.2" {
		t.Fatalf("User-Agent = %q, want opendum-gateway/0.2", headers["User-Agent"])
	}
}

func TestZenmuxHeaderPreserved(t *testing.T) {
	registry := NewRegistry(nil, nil, nil)
	provider, ok := registry.Get("zenmux")
	if !ok {
		t.Fatal("zenmux missing from registry")
	}
	compat := provider.(openAICompatibleProvider)
	headers := compat.extraRequestHeaders(appdb.ProviderAccount{})
	if headers["x-zenmux-apikey-source"] != "subscription" {
		t.Fatalf("x-zenmux-apikey-source = %q, want subscription", headers["x-zenmux-apikey-source"])
	}
}
