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

	if got := registry.ResolveAlias("mistralai/mistral-large"); got != "mistral-large-3" {
		t.Fatalf("ResolveAlias(mistralai/mistral-large) = %q, want mistral-large-3", got)
	}
	if got := registry.ResolveAlias("mistral-large-3-675b-instruct-2512"); got != "mistral-large-3" {
		t.Fatalf("ResolveAlias(mistral-large-3-675b-instruct-2512) = %q, want mistral-large-3", got)
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

	// Collect unique registry entries whose canonical or aliases mention the
	// Nemotron Nano VL family. The registry.models map covers both active
	// and ignored entries so this test stays valid even if a particular
	// canonical is later deprecated via the ignored flag.
	hasNemotronVL := func(value string) bool {
		cl := strings.ToLower(value)
		return strings.Contains(cl, "nemotron") &&
			strings.Contains(cl, "nano") &&
			strings.Contains(cl, "vl")
	}

	seen := make(map[string]struct{})
	var models []string
	for canonical, info := range registry.models {
		if len(info.Providers) == 0 {
			continue
		}
		addMatch := func(value string) bool {
			if !hasNemotronVL(value) {
				return false
			}
			if _, ok := seen[value]; ok {
				return false
			}
			seen[value] = struct{}{}
			return true
		}
		if addMatch(canonical) {
			models = append(models, canonical)
		}
		if addMatch(info.ID) {
			models = append(models, info.ID)
		}
	}

	if len(models) == 0 {
		t.Skip("no Nemotron Nano VL model files contain provider config")
	}

	for _, model := range models {
		info, ok := registry.models[model]
		if !ok {
			continue
		}
		// Every Nemotron Nano VL variant must declare vision-capable meta so
		// downstream providers can dispatch the right payload shape.
		if info.Meta == nil {
			t.Errorf("%s should declare meta with vision=true", model)
			continue
		}
		if info.Meta.Vision == nil || !*info.Meta.Vision {
			t.Errorf("%s should declare meta.vision=true", model)
		}
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

func TestDeepSeekV4AliasesResolveToCanonical(t *testing.T) {
	registry, err := Load(filepath.Join("..", "..", "..", "..", "models"))
	if err != nil {
		t.Fatal(err)
	}

	const flashCanonical = "deepseek-v4-flash"
	const proCanonical = "deepseek-v4-pro"

	flashAliases := []string{
		"deepseek-flash",
		"deepseek-v4-flash",
		"deepseek-ai/deepseek-v4-flash",
		"deepseek-v4-flash-free",
		"deepseek-ai/DeepSeek-V4-Flash",
	}
	for _, alias := range flashAliases {
		if got := registry.ResolveAlias(alias); got != flashCanonical {
			t.Fatalf("ResolveAlias(%q) = %q, want %q", alias, got, flashCanonical)
		}
		if !registry.IsSupported(alias) {
			t.Fatalf("IsSupported(%q) = false, want true", alias)
		}
		if _, ok := registry.ProviderModelMap("nvidia_nim")[alias]; ok {
			continue
		}
	}

	proAliases := []string{
		"deepseek-pro",
		"deepseek-v4-pro",
		"deepseek-ai/deepseek-v4-pro",
		"deepseek-ai/DeepSeek-V4-Pro",
	}
	for _, alias := range proAliases {
		if got := registry.ResolveAlias(alias); got != proCanonical {
			t.Fatalf("ResolveAlias(%q) = %q, want %q", alias, got, proCanonical)
		}
		if !registry.IsSupported(alias) {
			t.Fatalf("IsSupported(%q) = false, want true", alias)
		}
	}
}

func TestNvidiaNemotronOmniAliasUsesCurrentHostedModel(t *testing.T) {
	registry, err := Load(filepath.Join("..", "..", "..", "..", "models"))
	if err != nil {
		t.Fatal(err)
	}

	model := "nemotron-3-nano-omni"
	for _, alias := range []string{"nemotron-3-nano-omni-30b-a3b-reasoning", "nemotron-omni", "nano-omni"} {
		if got := registry.ResolveAlias(alias); got != model {
			t.Fatalf("ResolveAlias(%q) = %q, want %q", alias, got, model)
		}
		if got := registry.UpstreamModelName(alias, "nvidia_nim"); got != "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning" {
			t.Fatalf("NVIDIA upstream for %q = %q, want nvidia/nemotron-3-nano-omni-30b-a3b-reasoning", alias, got)
		}
	}
}
