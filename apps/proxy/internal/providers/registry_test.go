package providers

import "testing"

func TestProviderDisplayNamesMatchRegistry(t *testing.T) {
	registry := NewRegistry(nil, nil, nil)
	if len(providerDisplayNames) != len(registry.providers) {
		t.Fatalf("display names = %d entries, registry = %d entries", len(providerDisplayNames), len(registry.providers))
	}
	for name := range registry.providers {
		if _, ok := providerDisplayNames[name]; !ok {
			t.Fatalf("provider %q missing display name", name)
		}
	}
	for name := range providerDisplayNames {
		if _, ok := registry.providers[name]; !ok {
			t.Fatalf("display name for unregistered provider %q", name)
		}
	}
}

func TestRegistryNames(t *testing.T) {
	registry := NewRegistry(nil, nil, nil)
	names := registry.Names()
	if len(names) != len(registry.providers) {
		t.Fatalf("names = %d entries, registry = %d entries", len(names), len(registry.providers))
	}
	for i := 1; i < len(names); i++ {
		if names[i-1] >= names[i] {
			t.Fatalf("names not sorted: %v", names)
		}
	}
	for _, name := range names {
		if _, ok := registry.Get(name); !ok {
			t.Fatalf("name %q missing from registry", name)
		}
	}
}

func TestRefreshableProviderNames(t *testing.T) {
	registry := NewRegistry(nil, nil, nil)
	names := registry.RefreshableProviderNames()

	want := []string{"antigravity", "cline", "codex", "kiro", "perch", "qoder"}
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
