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
		"image-input":           {Meta: &Meta{Modalities: &Modalities{Input: []string{"text", "image"}}}},
		"text-input":            {Meta: &Meta{Modalities: &Modalities{Input: []string{"text"}}}},
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
		{name: "vision image input", got: registry.IsVisionModel("image-input"), want: true},
		{name: "vision text input", got: registry.IsVisionModel("text-input"), want: false},
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

func TestGeminiCLIExcludesGemmaModels(t *testing.T) {
	registry, err := Load(filepath.Join("..", "..", "..", "..", "models"))
	if err != nil {
		t.Fatal(err)
	}

	for _, model := range []string{"gemma-4-31b-it", "gemma-4-26b-a4b-it"} {
		if registry.IsSupportedByProvider(model, "gemini_cli") {
			t.Fatalf("%s should not be routed to gemini_cli Code Assist", model)
		}
	}
}

func TestSupportedModelsDeclareFamily(t *testing.T) {
	registry, err := Load(filepath.Join("..", "..", "..", "..", "models"))
	if err != nil {
		t.Fatal(err)
	}

	for model, info := range registry.effective {
		if len(info.Providers) == 0 {
			continue
		}
		if strings.TrimSpace(info.Family) == "" {
			t.Errorf("supported model %q must declare a family", model)
		}
	}
}
