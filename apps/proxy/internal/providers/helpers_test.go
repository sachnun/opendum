package providers

import (
	"net/http"
	"testing"
)

func TestDisplayName(t *testing.T) {
	t.Parallel()
	cases := map[string]string{
		"antigravity": "Antigravity",
		"codex":       "Codex",
		"openrouter":  "OpenRouter",
		"custom-x":    "custom-x",
		"":            "",
	}
	for provider, want := range cases {
		if got := DisplayName(provider); got != want {
			t.Errorf("DisplayName(%q) = %q, want %q", provider, got, want)
		}
	}
}

func TestNormalizeKiroTier(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name  string
		raw   string
		title string
		want  string
	}{
		{"standalone free", "Q_DEVELOPER_STANDALONE_FREE", "", "free"},
		{"standalone power", "q_developer_standalone_power", "", "power"},
		{"standalone pro", "Q_DEVELOPER_STANDALONE_PRO", "", "pro"},
		{"standalone pro plus", "Q_DEVELOPER_STANDALONE_PRO_PLUS", "", "pro-plus"},
		{"standalone", "Q_DEVELOPER_STANDALONE", "", "standalone"},
		{"title pro plus", "", "Kiro Pro+", "pro-plus"},
		{"title pro plus words", "", "Pro Plus plan", "pro-plus"},
		{"title power", "", "Power tier", "power"},
		{"title pro", "", "Pro", "pro"},
		{"title free", "", "Free plan", "free"},
		{"title fallback slug", "", "Custom_Tier-Name", "custom-tier-name"},
		{"empty", "", "", ""},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			if got := normalizeKiroTier(tc.raw, tc.title); got != tc.want {
				t.Fatalf("normalizeKiroTier(%q, %q) = %q, want %q", tc.raw, tc.title, got, tc.want)
			}
		})
	}
}

func TestInferMimeTypeFromURL(t *testing.T) {
	t.Parallel()
	cases := map[string]string{
		"https://x/y.png":     "image/png",
		"https://x/y.JPEG":    "image/jpeg",
		"https://x/y.pdf":     "application/pdf",
		"https://x/y.mp4":     "video/mp4",
		"https://x/y.mp3":     "audio/mpeg",
		"https://x/y.unknown": "image/jpeg",
		"https://x/y":         "image/jpeg",
	}
	for value, want := range cases {
		if got := inferMimeTypeFromURL(value); got != want {
			t.Errorf("inferMimeTypeFromURL(%q) = %q, want %q", value, got, want)
		}
	}
}

func TestIsPaidGoogleTierID(t *testing.T) {
	t.Parallel()
	for _, id := range []string{"paid", "standard-tier", "PAID", " paid "} {
		if !isPaidGoogleTierID(id) {
			t.Errorf("isPaidGoogleTierID(%q) = false, want true", id)
		}
	}
	for _, id := range []string{"free", "free-tier", "", "premium"} {
		if isPaidGoogleTierID(id) {
			t.Errorf("isPaidGoogleTierID(%q) = true, want false", id)
		}
	}
}

func TestNormalizeAntigravityTieredModel(t *testing.T) {
	t.Parallel()
	cases := map[string]string{
		"gemini-3-pro-high":    "gemini-3-pro",
		"gemini-3-pro-low":     "gemini-3-pro",
		"gemini-3-pro-medium":  "gemini-3-pro",
		"gemini-3-pro-minimal": "gemini-3-pro",
		"GEMINI-3-PRO-HIGH":    "gemini-3-pro",
		"gemini-3-pro":         "gemini-3-pro",
	}
	for input, want := range cases {
		if got := normalizeAntigravityTieredModel(input); got != want {
			t.Errorf("normalizeAntigravityTieredModel(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestParseDataURI(t *testing.T) {
	t.Parallel()
	mediaType, data, ok := parseDataURI("data:image/png;base64,QUJD")
	if !ok || mediaType != "image/png" || data != "QUJD" {
		t.Fatalf("parseDataURI = (%q, %q, %v), want (image/png, QUJD, true)", mediaType, data, ok)
	}
	mediaType, data, ok = parseDataURI("data:,QUJD")
	if !ok || mediaType != "image/png" || data != "QUJD" {
		t.Fatalf("default media type = (%q, %q, %v), want (image/png, QUJD, true)", mediaType, data, ok)
	}
	for _, invalid := range []string{"https://x/y.png", "data:image/png;base64", "data:,"} {
		if _, _, ok := parseDataURI(invalid); ok {
			t.Errorf("parseDataURI(%q) ok = true, want false", invalid)
		}
	}
}

func TestAnthropicImageBlock(t *testing.T) {
	t.Parallel()
	base64Source := map[string]any{"type": "base64", "data": "QUJD"}
	block := anthropicImageBlock(base64Source)
	if block == nil || block["type"] != "image" {
		t.Fatalf("base64 block = %v", block)
	}
	if source, _ := block["source"].(map[string]any); source["data"] != "QUJD" {
		t.Fatalf("base64 source = %v", block["source"])
	}

	dataURI := anthropicImageBlock(map[string]any{"url": "data:image/webp;base64,QUJD"})
	source, _ := dataURI["source"].(map[string]any)
	if source["type"] != "base64" || source["media_type"] != "image/webp" || source["data"] != "QUJD" {
		t.Fatalf("data URI source = %v", dataURI["source"])
	}

	urlBlock := anthropicImageBlock(map[string]any{"url": "https://x/y.png"})
	source, _ = urlBlock["source"].(map[string]any)
	if source["type"] != "url" || source["url"] != "https://x/y.png" {
		t.Fatalf("url source = %v", urlBlock["source"])
	}

	if got := anthropicImageBlock("nope"); got != nil {
		t.Fatalf("non-map = %v, want nil", got)
	}
	if got := anthropicImageBlock(map[string]any{"type": "base64"}); got != nil {
		t.Fatalf("base64 without data = %v, want nil", got)
	}
}

func TestCodexParseHelpers(t *testing.T) {
	t.Parallel()
	t.Run("parseFloatString", func(t *testing.T) {
		t.Parallel()
		for input, want := range map[string]float64{"": 0, "abc": 0, "-3": 0, "50.5": 50.5, "150": 100, " 25 ": 25} {
			if got := parseFloatString(input); got != want {
				t.Errorf("parseFloatString(%q) = %v, want %v", input, got, want)
			}
		}
	})
	t.Run("parseIntString", func(t *testing.T) {
		t.Parallel()
		if got := parseIntString(""); got != nil {
			t.Errorf("empty = %v, want nil", got)
		}
		if got := parseIntString("abc"); got != nil {
			t.Errorf("invalid = %v, want nil", got)
		}
		if got := parseIntString(" 60 "); got != int64(60) {
			t.Errorf("valid = %v, want int64(60)", got)
		}
	})
	t.Run("resetTimestamp", func(t *testing.T) {
		t.Parallel()
		if got := resetTimestamp(nil); got != nil {
			t.Errorf("nil = %v, want nil", got)
		}
		if got := resetTimestamp(int64(0)); got != nil {
			t.Errorf("zero = %v, want nil", got)
		}
		if got := resetTimestamp(int64(1_700_000_000)); got != int64(1_700_000_000_000) {
			t.Errorf("seconds = %v, want millis", got)
		}
		if got := resetTimestamp(int64(1_700_000_000_000)); got != int64(1_700_000_000_000) {
			t.Errorf("millis = %v, want unchanged", got)
		}
		if got := resetTimestamp("nope"); got != nil {
			t.Errorf("string = %v, want nil", got)
		}
	})
	t.Run("parseBoolString", func(t *testing.T) {
		t.Parallel()
		for _, input := range []string{"true", "TRUE", " 1 "} {
			if !parseBoolString(input) {
				t.Errorf("parseBoolString(%q) = false, want true", input)
			}
		}
		for _, input := range []string{"", "false", "0", "yes"} {
			if parseBoolString(input) {
				t.Errorf("parseBoolString(%q) = true, want false", input)
			}
		}
	})
	t.Run("nullableString", func(t *testing.T) {
		t.Parallel()
		if got := nullableString(""); got != nil {
			t.Errorf("empty = %v, want nil", got)
		}
		if got := nullableString("v"); got != "v" {
			t.Errorf("value = %v, want v", got)
		}
	})
	t.Run("numberFromAny", func(t *testing.T) {
		t.Parallel()
		if got := numberFromAny(float64(3.9)); got != 3 {
			t.Errorf("float = %d, want 3", got)
		}
		if got := numberFromAny(int64(7)); got != 7 {
			t.Errorf("int64 = %d, want 7", got)
		}
		if got := numberFromAny("x"); got != 0 {
			t.Errorf("string = %d, want 0", got)
		}
	})
}

func TestQuotaWindow(t *testing.T) {
	t.Parallel()
	window := quotaWindow("25", "60", "1700000000")
	if window["usedPercent"] != 25.0 || window["remainingPercent"] != 75.0 || window["remainingFraction"] != 0.75 {
		t.Fatalf("window = %v", window)
	}
	if window["windowMinutes"] != int64(60) || window["resetAt"] != int64(1700000000) {
		t.Fatalf("window metadata = %v", window)
	}
	if window["resetTimestamp"] != int64(1_700_000_000_000) {
		t.Fatalf("resetTimestamp = %v, want millis", window["resetTimestamp"])
	}
	if window["isExhausted"] != false {
		t.Fatalf("isExhausted = %v, want false", window["isExhausted"])
	}

	exhausted := quotaWindow("150", "", "")
	if exhausted["usedPercent"] != 100.0 || exhausted["remainingPercent"] != 0.0 || exhausted["isExhausted"] != true {
		t.Fatalf("exhausted window = %v", exhausted)
	}
	if exhausted["windowMinutes"] != nil || exhausted["resetAt"] != nil || exhausted["resetTimestamp"] != nil {
		t.Fatalf("exhausted metadata = %v", exhausted)
	}
}

func TestParseCodexQuotaHeaders(t *testing.T) {
	t.Parallel()
	if got := parseCodexQuotaHeaders(http.Header{}); got != nil {
		t.Fatalf("empty headers = %v, want nil", got)
	}

	headers := http.Header{
		"X-Codex-Primary-Used-Percent":   []string{"10"},
		"X-Codex-Primary-Window-Minutes": []string{"300"},
		"X-Codex-Primary-Reset-At":       []string{"1700000000"},
		"X-Codex-Credits-Has-Credits":    []string{"true"},
		"X-Codex-Credits-Unlimited":      []string{"1"},
		"X-Codex-Credits-Balance":        []string{"5"},
	}
	snapshot := parseCodexQuotaHeaders(headers)
	if snapshot == nil {
		t.Fatal("snapshot = nil, want populated")
	}
	if snapshot["primary"] == nil {
		t.Fatal("primary window missing")
	}
	if snapshot["secondary"] != nil {
		t.Fatal("secondary should be nil when header absent")
	}
	credits, _ := snapshot["credits"].(map[string]any)
	if credits["hasCredits"] != true || credits["unlimited"] != true || credits["balance"] != "5" {
		t.Fatalf("credits = %v", credits)
	}

	withoutBalance := parseCodexQuotaHeaders(http.Header{"X-Codex-Primary-Used-Percent": []string{"10"}})
	if withoutBalance["credits"] != nil {
		t.Fatalf("credits = %v, want nil without credits header", withoutBalance["credits"])
	}
}

func TestNormalizeToolChoice(t *testing.T) {
	t.Parallel()
	flattened := normalizeToolChoice(map[string]any{"type": "function", "function": map[string]any{"name": "foo"}})
	got, _ := flattened.(map[string]any)
	if got["type"] != "function" || got["name"] != "foo" || got["function"] != nil {
		t.Fatalf("nested choice = %v", flattened)
	}

	named := normalizeToolChoice(map[string]any{"type": "function", "name": "bar"})
	got, _ = named.(map[string]any)
	if got["name"] != "bar" {
		t.Fatalf("named choice = %v", named)
	}

	if got := normalizeToolChoice("auto"); got != "auto" {
		t.Fatalf("string choice = %v, want auto", got)
	}
	if got := normalizeToolChoice(nil); got != nil {
		t.Fatalf("nil choice = %v, want nil", got)
	}
	noName := map[string]any{"type": "function"}
	if got, ok := normalizeToolChoice(noName).(map[string]any); !ok || got["name"] != nil {
		t.Fatalf("choice without name = %v, want unchanged", got)
	}
}

func TestUniqueStringsAndStringSlice(t *testing.T) {
	t.Parallel()
	got := uniqueStrings([]string{"a", "", "b", "a", "c"})
	want := []string{"a", "b", "c"}
	if len(got) != len(want) {
		t.Fatalf("uniqueStrings = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("uniqueStrings = %v, want %v", got, want)
		}
	}

	if got := stringSlice([]any{"a", "", "b"}); len(got) != 2 || got[0] != "a" || got[1] != "b" {
		t.Fatalf("stringSlice = %v, want [a b]", got)
	}
	if got := stringSlice("not-a-slice"); len(got) != 0 {
		t.Fatalf("stringSlice(non-slice) = %v, want empty", got)
	}
}
