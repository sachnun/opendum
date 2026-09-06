package providers

import "testing"

func TestSanitizeKey(t *testing.T) {
	cases := map[string]string{
		"a/b:c":     "a-b-c",
		"a--b":      "a-b",
		"x.y_z":     "x.y_z",
		"My Model!": "My-Model-",
	}
	for input, want := range cases {
		if got := sanitizeKey(input); got != want {
			t.Errorf("sanitizeKey(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestBuildSuffixedMap(t *testing.T) {
	m := buildSuffixedMap([]string{"first", "second"}, func(string) string { return "k" })
	if m["k"] != "first" {
		t.Errorf("m[k] = %q, want first", m["k"])
	}
	if m["k-2"] != "second" {
		t.Errorf("m[k-2] = %q, want second", m["k-2"])
	}
	if len(m) != 2 {
		t.Errorf("expected 2 keys, got %d", len(m))
	}
}

func TestBuildSuffixedMapNoCollision(t *testing.T) {
	m := buildSuffixedMap([]string{"a", "b"}, sanitizeKey)
	if m["a"] != "a" || m["b"] != "b" {
		t.Errorf("unexpected map: %v", m)
	}
}

func TestTrimFreeSuffix(t *testing.T) {
	if got := trimFreeSuffix("claude-free"); got != "claude" {
		t.Errorf("trimFreeSuffix(claude-free) = %q, want claude", got)
	}
	if got := trimFreeSuffix("claude"); got != "claude" {
		t.Errorf("trimFreeSuffix(claude) = %q, want claude", got)
	}
}
