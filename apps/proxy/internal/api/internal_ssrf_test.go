package api

import "testing"

func TestResolveInternalRelayTargetRejectsPrivateHosts(t *testing.T) {
	t.Setenv("OPENDUM_ALLOW_PRIVATE_RELAY", "")
	private := []string{
		"https://127.0.0.1/v1/models",
		"https://10.0.0.1/v1/models",
		"https://172.16.5.5/v1/models",
		"https://192.168.1.1/v1/models",
		"https://169.254.169.254/latest/meta-data",
		"https://localhost/v1/models",
		"https://internal.local/v1/models",
		"https://[::1]/v1/models",
	}
	for _, raw := range private {
		if _, _, err := resolveInternalRelayTarget(internalRelayRequest{URL: raw, Method: "GET"}); err == nil {
			t.Fatalf("resolveInternalRelayTarget(%q) error = nil, want private host rejection", raw)
		}
	}
	if _, _, err := resolveInternalRelayTarget(internalRelayRequest{URL: "https://openrouter.ai/api/v1/models", Method: "GET"}); err != nil {
		t.Fatalf("resolveInternalRelayTarget(public) error = %v, want nil", err)
	}
}

func TestResolveInternalRelayTargetAllowsPrivateHostsWhenConfigured(t *testing.T) {
	t.Setenv("OPENDUM_ALLOW_PRIVATE_RELAY", "true")
	if _, _, err := resolveInternalRelayTarget(internalRelayRequest{URL: "https://127.0.0.1:4000/v1/models", Method: "GET"}); err != nil {
		t.Fatalf("resolveInternalRelayTarget(private with override) error = %v, want nil", err)
	}
}
