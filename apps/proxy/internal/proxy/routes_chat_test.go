package proxy

import "testing"

func TestReasoningRequestedRespectsOff(t *testing.T) {
	cases := []struct {
		name string
		body map[string]any
		want bool
	}{
		{"no reasoning fields", map[string]any{}, false},
		{"reasoning effort none", map[string]any{"reasoning": map[string]any{"effort": "none"}}, false},
		{"reasoning_effort none", map[string]any{"reasoning_effort": "none"}, false},
		{"include_thoughts false", map[string]any{"include_thoughts": false}, false},
		{"reasoning include_thoughts false", map[string]any{"reasoning": map[string]any{"include_thoughts": false}}, false},
		{"reasoning camel includeThoughts false", map[string]any{"reasoning": map[string]any{"includeThoughts": false}}, false},
		{"reasoning effort low", map[string]any{"reasoning": map[string]any{"effort": "low"}}, true},
		{"reasoning_effort high", map[string]any{"reasoning_effort": "high"}, true},
		{"include_thoughts true", map[string]any{"include_thoughts": true}, true},
		{"thinking_budget", map[string]any{"thinking_budget": 1024}, true},
		{"empty reasoning object", map[string]any{"reasoning": map[string]any{}}, true},
		{"reasoning effort None casing", map[string]any{"reasoning": map[string]any{"effort": "None"}}, false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := reasoningRequested(tc.body); got != tc.want {
				t.Fatalf("reasoningRequested(%#v) = %v, want %v", tc.body, got, tc.want)
			}
		})
	}
}
