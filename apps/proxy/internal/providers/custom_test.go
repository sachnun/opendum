package providers

import (
	"testing"

	appdb "github.com/opendum/opendum/apps/proxy/internal/db"
)

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
