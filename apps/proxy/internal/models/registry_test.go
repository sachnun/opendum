package models

import "testing"

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
