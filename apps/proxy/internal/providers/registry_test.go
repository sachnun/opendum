package providers

import "testing"

func TestRefreshableProviderNames(t *testing.T) {
	registry := NewRegistry(nil, nil, nil)
	names := registry.RefreshableProviderNames()

	want := []string{"antigravity", "codex", "kiro", "qoder"}
	if len(names) != len(want) {
		t.Fatalf("names = %#v, want %#v", names, want)
	}
	for i := range want {
		if names[i] != want[i] {
			t.Fatalf("names = %#v, want %#v", names, want)
		}
	}
	for _, name := range names {
		provider, ok := registry.Get(name)
		if !ok {
			t.Fatalf("refreshable provider %q missing from registry", name)
		}
		if _, ok := provider.(CredentialRefresher); !ok {
			t.Fatalf("provider %q does not implement CredentialRefresher", name)
		}
	}
}

func TestRefreshBufferDefaultsToOAuthBuffer(t *testing.T) {
	registry := NewRegistry(nil, nil, nil)
	openrouter, ok := registry.Get("openrouter")
	if !ok {
		t.Fatal("openrouter provider missing")
	}

	if got := RefreshBufferFor(openrouter); got != oauthRefreshBuffer {
		t.Fatalf("default buffer = %s, want %s", got, oauthRefreshBuffer)
	}
}
