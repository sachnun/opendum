package providers

import (
	"net/http"
	"net/url"
	"testing"
)

func TestPrivateHost(t *testing.T) {
	private := []string{
		"127.0.0.1",
		"10.0.0.5",
		"172.16.5.5",
		"192.168.1.1",
		"169.254.169.254",
		"100.64.5.5",
		"0.0.0.0",
		"::1",
		"fe80::1",
		"fc00::1",
		"localhost",
		"db.internal",
		"k8s.local",
		"[::ffff:10.0.0.1]",
	}
	for _, host := range private {
		if !PrivateHost(host) {
			t.Fatalf("PrivateHost(%q) = false, want true", host)
		}
	}
	public := []string{
		"openrouter.ai",
		"api.openai.com",
		"8.8.8.8",
		"[2606:4700:4700::1111]",
	}
	for _, host := range public {
		if PrivateHost(host) {
			t.Fatalf("PrivateHost(%q) = true, want false", host)
		}
	}
}

func redirectRequest(rawURL string) *http.Request {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		panic(err)
	}
	return &http.Request{URL: parsed}
}

func TestGuardedRedirectPolicy(t *testing.T) {
	policy := GuardedRedirectPolicy(func() bool { return false })

	if err := policy(redirectRequest("https://openrouter.ai/v1"), nil); err != nil {
		t.Fatalf("public https redirect rejected: %v", err)
	}
	for _, target := range []string{
		"https://169.254.169.254/latest/meta-data",
		"https://10.0.0.1/x",
		"https://metadata.internal/x",
		"http://openrouter.ai/v1",
	} {
		if err := policy(redirectRequest(target), nil); err == nil {
			t.Fatalf("redirect to %q accepted, want rejection", target)
		}
	}

	hops := make([]*http.Request, 10)
	if err := policy(redirectRequest("https://openrouter.ai/v1"), hops); err == nil {
		t.Fatal("redirect loop accepted, want rejection after 10 hops")
	}
}

func TestGuardedRedirectPolicyAllowsPrivateWhenConfigured(t *testing.T) {
	policy := GuardedRedirectPolicy(func() bool { return true })
	if err := policy(redirectRequest("https://127.0.0.1:4000/v1/models"), nil); err != nil {
		t.Fatalf("private redirect rejected despite override: %v", err)
	}
}
