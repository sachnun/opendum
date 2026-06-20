package providers

import (
	"encoding/base64"
	"strings"
	"testing"
)

func TestQoderEncodeBodyRoundtrip(t *testing.T) {
	// The encoding must be deterministic for a fixed input and produce a
	// non-trivially scrambled string that is not the plain base64.
	plaintext := []byte(`{"model":"qmodel_latest","messages":[]}`)
	encoded := qoderEncodeBody(plaintext)
	if encoded == "" {
		t.Fatal("encoded body is empty")
	}
	if encoded == base64.StdEncoding.EncodeToString(plaintext) {
		t.Fatal("encoded body equals plain base64; alphabet substitution did not run")
	}
	if strings.ContainsAny(encoded, "=") {
		t.Fatalf("encoded body still contains '=' padding: %q", encoded)
	}
}

func TestQoderAuthHeadersAreComplete(t *testing.T) {
	headers := buildQoderAuthHeaders([]byte("body"), "https://api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?Encode=1", "uid-123", "mid-456", "dt-token")
	required := []string{
		"Authorization", "Cosy-Key", "Cosy-User", "Cosy-Date", "Cosy-Version",
		"Cosy-Machineid", "Cosy-Machinetoken", "Cosy-Machinetype", "Cosy-Machineos",
		"Cosy-Clienttype", "Cosy-Clientip", "Cosy-Bodyhash", "Cosy-Bodylength",
		"Cosy-Sigpath", "Cosy-Data-Policy", "Login-Version", "X-Request-Id",
		"Content-Type", "Accept",
	}
	for _, key := range required {
		if headers[key] == "" {
			t.Errorf("missing or empty header %q", key)
		}
	}
	if !strings.HasPrefix(headers["Authorization"], "Bearer COSY.") {
		t.Fatalf("Authorization header = %q, want Bearer COSY. prefix", headers["Authorization"])
	}
	if headers["Cosy-User"] != "uid-123" {
		t.Fatalf("Cosy-User = %q, want uid-123", headers["Cosy-User"])
	}
	if headers["Cosy-Machineid"] != "mid-456" {
		t.Fatalf("Cosy-Machineid = %q, want mid-456", headers["Cosy-Machineid"])
	}
}

func TestQoderSigPathStripsAlgo(t *testing.T) {
	cases := map[string]string{
		"https://api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?Encode=1": "/api/v2/service/pro/sse/agent_chat_generation",
		"https://api3.qoder.sh/algo/api/v2/model/list":                                     "/api/v2/model/list",
	}
	for input, want := range cases {
		if got := qoderSigPath(input); got != want {
			t.Errorf("qoderSigPath(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestSplitQoderAccountID(t *testing.T) {
	uid, mid := splitQoderAccountID(ptrString("user-1|machine-1"))
	if uid != "user-1" || mid != "machine-1" {
		t.Fatalf("splitQoderAccountID = (%q, %q), want (user-1, machine-1)", uid, mid)
	}
	uid, mid = splitQoderAccountID(ptrString("single-value"))
	if uid != "single-value" || mid != "single-value" {
		t.Fatalf("splitQoderAccountID legacy = (%q, %q), want single-value", uid, mid)
	}
	uid, mid = splitQoderAccountID(nil)
	if uid != "" || mid != "" {
		t.Fatalf("splitQoderAccountID(nil) = (%q, %q), want empty", uid, mid)
	}
}

func ptrString(s string) *string { return &s }

// qoderRefreshEndpointFor mirrors the branch inside RefreshCredentials so the
// routing decision can be unit-tested without spinning up an HTTP server.
func qoderRefreshEndpointFor(refreshToken string) string {
	if strings.HasPrefix(strings.TrimSpace(refreshToken), qoderPATRefreshPrefix) {
		return qoderJobRefreshPath
	}
	return qoderDeviceRefreshPath
}

func TestQoderRefreshEndpointRouting(t *testing.T) {
	cases := map[string]string{
		"jrt-IPFmOhi5":         qoderJobRefreshPath,    // PAT-exchanged (personal token)
		"drt-ign208Bt":         qoderDeviceRefreshPath, // device flow
		"jrt-":                 qoderJobRefreshPath,    // bare prefix still routes to job refresh
		"drt-abc":              qoderDeviceRefreshPath,
		"  jrt-spaces  ":       qoderJobRefreshPath,    // trimming does not change routing
		"unknown-prefix-token": qoderDeviceRefreshPath, // default route is the device endpoint
	}
	for token, want := range cases {
		if got := qoderRefreshEndpointFor(token); got != want {
			t.Errorf("qoderRefreshEndpointFor(%q) = %q, want %q", token, got, want)
		}
	}
}
