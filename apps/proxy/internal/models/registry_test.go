package models

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestCapabilityChecksDefaultToSupportedForMissingMetadata(t *testing.T) {
	visionFalse := false
	visionTrue := true
	reasoningFalse := false
	toolCallFalse := false
	registry := &Registry{effective: map[string]Info{
		"no-meta":               {},
		"empty-meta":            {Meta: &Meta{}},
		"explicit-vision-false": {Meta: &Meta{Vision: &visionFalse}},
		"explicit-vision-true":  {Meta: &Meta{Vision: &visionTrue}},
		"explicit-reasoning-off": {Meta: &Meta{
			Reasoning: &reasoningFalse,
		}},
		"explicit-tool-off": {Meta: &Meta{
			ToolCall: &toolCallFalse,
		}},
	}}

	tests := []struct {
		name string
		got  bool
		want bool
	}{
		{name: "vision no meta", got: registry.IsVisionModel("no-meta"), want: true},
		{name: "vision empty meta", got: registry.IsVisionModel("empty-meta"), want: true},
		{name: "vision explicit false", got: registry.IsVisionModel("explicit-vision-false"), want: false},
		{name: "vision explicit true", got: registry.IsVisionModel("explicit-vision-true"), want: true},
		{name: "vision unknown", got: registry.IsVisionModel("unknown"), want: false},
		{name: "reasoning no meta", got: registry.IsReasoningModel("no-meta"), want: true},
		{name: "reasoning empty meta", got: registry.IsReasoningModel("empty-meta"), want: true},
		{name: "reasoning explicit false", got: registry.IsReasoningModel("explicit-reasoning-off"), want: false},
		{name: "reasoning unknown", got: registry.IsReasoningModel("unknown"), want: false},
		{name: "tool no meta", got: registry.IsToolCallModel("no-meta"), want: true},
		{name: "tool empty meta", got: registry.IsToolCallModel("empty-meta"), want: true},
		{name: "tool explicit false", got: registry.IsToolCallModel("explicit-tool-off"), want: false},
		{name: "tool unknown", got: registry.IsToolCallModel("unknown"), want: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if tt.got != tt.want {
				t.Fatalf("got %v, want %v", tt.got, tt.want)
			}
		})
	}
}

func TestWorkersAIModelsDeclareCloudflareUpstream(t *testing.T) {
	registry, err := Load(filepath.Join("..", "..", "..", "..", "models"))
	if err != nil {
		t.Fatal(err)
	}

	for model, upstream := range registry.ProviderModelMap("workers_ai") {
		if upstream == model || !strings.HasPrefix(upstream, "@") {
			t.Fatalf("workers_ai model %q must declare a Cloudflare upstream, got %q", model, upstream)
		}
	}
}

func TestKiloCodeOnlyExposesFreeAuthlessModels(t *testing.T) {
	registry, err := Load(filepath.Join("..", "..", "..", "..", "models"))
	if err != nil {
		t.Fatal(err)
	}

	for _, model := range []string{"kilo-auto-free", "kilo-auto-small", "kilo-auto-balanced", "kilo-auto-frontier"} {
		if registry.IsSupportedByProvider(model, "kilo_code") {
			t.Fatalf("%s should remain ignored for kilo_code", model)
		}
	}

	for model, upstream := range registry.ProviderModelMap("kilo_code") {
		if !strings.HasSuffix(upstream, ":free") && upstream != "openrouter/free" && upstream != "openrouter/owl-alpha" {
			t.Fatalf("kilo_code model %q must use free upstream, got %q", model, upstream)
		}
		if !registry.IsAuthlessProviderModel(model, "kilo_code") {
			t.Fatalf("kilo_code model %q must be authless", model)
		}
	}
}

func TestNvidiaMistralLargeAliasUsesCurrentHostedModel(t *testing.T) {
	registry, err := Load(filepath.Join("..", "..", "..", "..", "models"))
	if err != nil {
		t.Fatal(err)
	}

	if got := registry.ResolveAlias("mistralai/mistral-large"); got != "mistral-large-3-675b" {
		t.Fatalf("ResolveAlias(mistralai/mistral-large) = %q, want mistral-large-3-675b", got)
	}
	if got := registry.ResolveAlias("mistral-large-3-675b-instruct-2512"); got != "mistral-large-3-675b" {
		t.Fatalf("ResolveAlias(mistral-large-3-675b-instruct-2512) = %q, want mistral-large-3-675b", got)
	}
	if got := registry.UpstreamModelName("mistralai/mistral-large", "nvidia_nim"); got != "mistralai/mistral-large-3-675b-instruct-2512" {
		t.Fatalf("NVIDIA upstream = %q, want mistralai/mistral-large-3-675b-instruct-2512", got)
	}
	if _, ok := registry.ProviderModelMap("nvidia_nim")["mistral-large"]; ok {
		t.Fatal("deprecated mistral-large model key should not be exposed as a separate NVIDIA NIM registry entry")
	}
}

func TestNvidiaNemotronNanoVLDisablesToolCalling(t *testing.T) {
	registry, err := Load(filepath.Join("..", "..", "..", "..", "models"))
	if err != nil {
		t.Fatal(err)
	}

	model := "nemotron-nano-vl"
	if got := registry.ResolveAlias("llama-3.1-nemotron-nano-vl-8b-v1"); got != model {
		t.Fatalf("ResolveAlias(llama-3.1-nemotron-nano-vl-8b-v1) = %q, want %q", got, model)
	}
	if !registry.IsVisionModel(model) {
		t.Fatal("Nemotron Nano VL should remain vision-capable")
	}
	if registry.IsToolCallModel(model) {
		t.Fatal("Nemotron Nano VL should not send OpenAI tool parameters to NVIDIA NIM")
	}
}

func TestProviderAliasesUseConfiguredUpstreams(t *testing.T) {
	registry, err := Load(filepath.Join("..", "..", "..", "..", "models"))
	if err != nil {
		t.Fatal(err)
	}

	checked := 0
	for canonical, info := range registry.effective {
		aliases := registry.LookupKeys(canonical)
		for provider, cfg := range info.ProviderConfig {
			if cfg.Upstream == "" || !contains(info.Providers, provider) {
				continue
			}
			checked++
			for _, alias := range aliases {
				if registry.ResolveAlias(alias) != canonical {
					continue
				}
				if got := registry.UpstreamModelName(alias, provider); got != cfg.Upstream {
					t.Fatalf("UpstreamModelName(%q, %q) = %q, want %q", alias, provider, got, cfg.Upstream)
				}
			}
		}
	}
	if checked == 0 {
		t.Fatal("expected at least one configured provider upstream")
	}
}

func TestNvidiaNemotronOmniAliasUsesCurrentHostedModel(t *testing.T) {
	registry, err := Load(filepath.Join("..", "..", "..", "..", "models"))
	if err != nil {
		t.Fatal(err)
	}

	model := "nemotron-3-nano"
	for _, alias := range []string{"nemotron-3-nano-omni-30b-a3b-reasoning", "nemotron-omni", "nano-omni"} {
		if got := registry.ResolveAlias(alias); got != model {
			t.Fatalf("ResolveAlias(%q) = %q, want %q", alias, got, model)
		}
		if got := registry.UpstreamModelName(alias, "nvidia_nim"); got != "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning" {
			t.Fatalf("NVIDIA upstream for %q = %q, want nvidia/nemotron-3-nano-omni-30b-a3b-reasoning", alias, got)
		}
	}
}
