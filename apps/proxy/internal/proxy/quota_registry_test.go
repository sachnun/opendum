package proxy

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
)

func TestQuotaFetcherRegistryHasExpectedProviders(t *testing.T) {
	registry := (&Service{}).quotaFetcherRegistry()
	expected := []string{"antigravity", "codex", "kiro", "openrouter", "perch", "siliconflow", "zenmux"}
	got := make([]string, 0, len(registry))
	for name := range registry {
		got = append(got, name)
	}
	sort.Strings(got)
	sort.Strings(expected)
	if strings.Join(got, ",") != strings.Join(expected, ",") {
		t.Fatalf("quota fetcher registry = %v, want %v", got, expected)
	}
}

func TestQuotaFetcherRegistryMatchesDashboard(t *testing.T) {
	registry := (&Service{}).quotaFetcherRegistry()
	content, err := os.ReadFile(filepath.Join("..", "..", "..", "dashboard", "lib", "provider-accounts.ts"))
	if err != nil {
		t.Skipf("dashboard QUOTA_PROVIDER_KEYS not available yet: %v", err)
	}
	tsKeys, ok := parseQuotaProviderKeys(string(content))
	if !ok {
		t.Skip("dashboard QUOTA_PROVIDER_KEYS not available yet")
	}

	goSet := map[string]bool{}
	for name := range registry {
		goSet[name] = true
	}
	tsSet := map[string]bool{}
	for _, key := range tsKeys {
		tsSet[key] = true
	}
	if len(goSet) != len(tsSet) {
		t.Fatalf("quota provider sets differ: Go = %v, dashboard = %v", sortedKeys(goSet), sortedKeys(tsSet))
	}
	for name := range goSet {
		if !tsSet[name] {
			t.Fatalf("quota provider %q registered in Go but missing from dashboard QUOTA_PROVIDER_KEYS", name)
		}
	}
	for name := range tsSet {
		if !goSet[name] {
			t.Fatalf("dashboard QUOTA_PROVIDER_KEYS includes %q which is not registered in Go", name)
		}
	}
}

func parseQuotaProviderKeys(content string) ([]string, bool) {
	literal := regexp.MustCompile(`(?s)QUOTA_PROVIDER_KEYS[^=]*=\s*\[(.*?)\]`)
	match := literal.FindStringSubmatch(content)
	if len(match) != 2 {
		return nil, false
	}
	key := regexp.MustCompile(`"([^"]+)"`)
	keys := []string{}
	for _, sub := range key.FindAllStringSubmatch(match[1], -1) {
		keys = append(keys, sub[1])
	}
	if len(keys) == 0 {
		return nil, false
	}
	return keys, true
}

func sortedKeys(set map[string]bool) []string {
	keys := make([]string, 0, len(set))
	for name := range set {
		keys = append(keys, name)
	}
	sort.Strings(keys)
	return keys
}
