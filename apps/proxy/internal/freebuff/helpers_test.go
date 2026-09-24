package freebuff

import (
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestQueuedPollDelay(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name       string
		waitMillis int64
		want       time.Duration
	}{
		{"unset uses poll interval", 0, pollInterval},
		{"negative uses poll interval", -5, pollInterval},
		{"below one second clamps up", 500, time.Second},
		{"within range preserved", 3000, 3 * time.Second},
		{"above cap uses poll interval", 60000, pollInterval},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			if got := queuedPollDelay(freeSessionResponse{EstimatedWaitMs: tc.waitMillis}); got != tc.want {
				t.Fatalf("queuedPollDelay(%d) = %v, want %v", tc.waitMillis, got, tc.want)
			}
		})
	}
}

func TestIsBannedMessage(t *testing.T) {
	t.Parallel()
	for _, message := range []string{"You are banned", "ACCOUNT_BANNED", "error: banned_user detected"} {
		if !isBannedMessage(message) {
			t.Errorf("isBannedMessage(%q) = false, want true", message)
		}
	}
	// Third-party-client suspension arrives as a plain-text error body, so it
	// must be detected by substring rather than by the status marker.
	suspended := `{"error":"account_suspended","message":"Your account has been suspended for using a third-party client or proxy to access Freebuff."}`
	if !isBannedMessage(suspended) {
		t.Errorf("isBannedMessage(account_suspended body) = false, want true")
	}
	for _, message := range []string{"", "rate limited", "model unavailable"} {
		if isBannedMessage(message) {
			t.Errorf("isBannedMessage(%q) = true, want false", message)
		}
	}
}

func TestHasApprovedFreeTierTool(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name  string
		tools []any
		want  bool
	}{
		{"empty", nil, false},
		{"custom tools only", []any{testTool("bash"), testTool("read")}, false},
		{"signature name without schema", []any{testTool("read_files")}, false},
		{"signature name with foreign schema", []any{foreignSchemaTool("read_files", "file_path")}, false},
		{"genuine among customs", []any{testTool("bash"), genuineTool("read_files")}, true},
		{"genuine alone", []any{genuineTool("set_output")}, true},
		{"non-map entry ignored", []any{"junk", genuineTool("read_files")}, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := hasApprovedFreeTierTool(tt.tools); got != tt.want {
				t.Fatalf("hasApprovedFreeTierTool() = %v, want %v", got, tt.want)
			}
		})
	}
}

// testTool is a bare tool with an empty parameter schema.
func testTool(name string) map[string]any {
	return map[string]any{
		"type": "function",
		"function": map[string]any{
			"name":        name,
			"description": "d",
			"parameters":  map[string]any{"type": "object"},
		},
	}
}

// foreignSchemaTool is a signature name carrying another harness's parameter
// names, the shape the upstream gate rejects.
func foreignSchemaTool(name, property string) map[string]any {
	return map[string]any{
		"type": "function",
		"function": map[string]any{
			"name":        name,
			"description": "d",
			"parameters": map[string]any{
				"type":       "object",
				"properties": map[string]any{property: map[string]any{"type": "string"}},
			},
		},
	}
}

func TestFirstNonEmpty(t *testing.T) {
	t.Parallel()
	if got := firstNonEmpty("  ", "", "value", "other"); got != "value" {
		t.Fatalf("firstNonEmpty = %q, want value", got)
	}
	if got := firstNonEmpty("", "  "); got != "" {
		t.Fatalf("firstNonEmpty all blank = %q, want empty", got)
	}
	if got := firstNonEmpty(" padded ", "b"); got != " padded " {
		t.Fatalf("firstNonEmpty preserves value = %q", got)
	}
}

func TestMismatch(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name      string
		state     freeSessionResponse
		requested string
		want      bool
	}{
		{"active different model", freeSessionResponse{Status: "active", Model: "a"}, "b", true},
		{"queued different model", freeSessionResponse{Status: "queued", Model: "a"}, "b", true},
		{"active same model", freeSessionResponse{Status: "active", Model: "a"}, "a", false},
		{"inactive status ignored", freeSessionResponse{Status: "banned", Model: "a"}, "b", false},
		{"no requested model", freeSessionResponse{Status: "active", Model: "a"}, "", false},
		{"no actual model", freeSessionResponse{Status: "active"}, "b", false},
		{"whitespace trimmed", freeSessionResponse{Status: " active ", Model: " a "}, "a", false},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			if got := mismatch(tc.state, tc.requested); got != tc.want {
				t.Fatalf("mismatch = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestErrorTypeFor(t *testing.T) {
	t.Parallel()
	cases := map[int]string{
		http.StatusUnauthorized:        "authentication_error",
		http.StatusForbidden:           "authentication_error",
		http.StatusTooManyRequests:     "rate_limit_error",
		http.StatusInternalServerError: "upstream_error",
		http.StatusOK:                  "upstream_error",
	}
	for status, want := range cases {
		if got := errorTypeFor(status); got != want {
			t.Errorf("errorTypeFor(%d) = %q, want %q", status, got, want)
		}
	}
}

func TestParseOptionalTime(t *testing.T) {
	t.Parallel()
	parsed := parseOptionalTime(" 2023-01-02T03:04:05Z ")
	if parsed.IsZero() || parsed.UTC().Format(time.RFC3339) != "2023-01-02T03:04:05Z" {
		t.Fatalf("parseOptionalTime = %v", parsed)
	}
	for _, invalid := range []string{"", "not-a-time", "2023-01-02"} {
		if got := parseOptionalTime(invalid); !got.IsZero() {
			t.Errorf("parseOptionalTime(%q) = %v, want zero", invalid, got)
		}
	}
}

func TestNewClientIDFormat(t *testing.T) {
	t.Parallel()
	const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz"
	for i := 0; i < 32; i++ {
		id := newClientID()
		if len(id) != 13 {
			t.Fatalf("id length = %d (%q), want 13", len(id), id)
		}
		for _, char := range id {
			if !strings.ContainsRune(alphabet, char) {
				t.Fatalf("id %q contains invalid char %q", id, char)
			}
		}
	}
}
