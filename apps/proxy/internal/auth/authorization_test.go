package auth

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/opendum/opendum/apps/proxy/internal/models"
)

const mockLockedModel = "mock-locked-model"

func mockRegistry(t *testing.T) *models.Registry {
	t.Helper()
	dir := t.TempDir()
	writeMockModel(t, dir, mockLockedModel, map[string]any{
		"providers": []string{"mockprov"},
		"providerConfig": map[string]any{
			"mockprov": map[string]any{
				"allowedTiers": []string{"pro", "pro+", "power", "standalone"},
			},
		},
	})
	registry, err := models.Load(dir)
	if err != nil {
		t.Fatalf("load mock registry: %v", err)
	}
	return registry
}

func writeMockModel(t *testing.T, dir, name string, body map[string]any) {
	t.Helper()
	data, err := json.MarshalIndent(body, "", "  ")
	if err != nil {
		t.Fatalf("marshal mock model %s: %v", name, err)
	}
	if err := os.WriteFile(filepath.Join(dir, name+".json"), data, 0o644); err != nil {
		t.Fatalf("write mock model %s: %v", name, err)
	}
}

func TestNormalizeTierAlias(t *testing.T) {
	t.Parallel()
	cases := map[string]string{
		"":                       "",
		"  PRO  ":                "pro",
		"pro_plus":               "pro+",
		"proplus":                "pro+",
		"PRO-PLUS":               "pro+",
		"free-tier":              "free",
		"education":              "student",
		"educational":            "student",
		"edu":                    "student",
		"free-educational-quota": "student",
		"standard-tier":          "standard-tier",
	}
	for input, want := range cases {
		if got := normalizeTierAlias(input); got != want {
			t.Errorf("normalizeTierAlias(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestTierSatisfiesRule(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name         string
		accountTier  string
		minTier      string
		allowedTiers []string
		want         bool
	}{
		{"allowed tiers exact match", "pro", "", []string{"pro", "pro+"}, true},
		{"allowed tiers alias match", "pro_plus", "", []string{"pro+"}, true},
		{"allowed tiers no match", "free", "", []string{"pro", "pro+"}, false},
		{"allowed tiers empty account", "", "", []string{"pro"}, false},
		{"empty min tier allows anyone", "free", "", nil, true},
		{"free min tier allows anyone", "free", "free", nil, true},
		{"min tier requires exact", "pro", "pro", nil, true},
		{"min tier rejects lower", "free", "pro", nil, false},
		{"min tier rejects empty", "", "pro", nil, false},
		{"min tier free alias treated as free", "free", "free-tier", nil, true},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			if got := tierSatisfiesRule(tc.accountTier, tc.minTier, tc.allowedTiers); got != tc.want {
				t.Fatalf("tierSatisfiesRule(%q, %q, %v) = %v, want %v", tc.accountTier, tc.minTier, tc.allowedTiers, got, tc.want)
			}
		})
	}
}

func TestAccessRuleRestrictsTier(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name         string
		minTier      string
		allowedTiers []string
		want         bool
	}{
		{"allowed tiers restrict", "", []string{"pro"}, true},
		{"empty rule unrestricted", "", nil, false},
		{"free min tier unrestricted", "free", nil, false},
		{"free alias unrestricted", "free-tier", nil, false},
		{"paid min tier restricts", "pro", nil, true},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			if got := accessRuleRestrictsTier(tc.minTier, tc.allowedTiers); got != tc.want {
				t.Fatalf("accessRuleRestrictsTier(%q, %v) = %v, want %v", tc.minTier, tc.allowedTiers, got, tc.want)
			}
		})
	}
}

func TestNormalizeAccountList(t *testing.T) {
	t.Parallel()
	got := normalizeAccountList([]string{" b ", "a", "", "  ", "b", "c"})
	want := []string{"a", "b", "c"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("normalizeAccountList = %v, want %v", got, want)
	}
}

func TestParseModelParam(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name         string
		modelParam   string
		wantProvider *string
		wantModel    string
	}{
		{"no provider prefix", "mock-locked-model", nil, "mock-locked-model"},
		{"provider prefix", "mockprov/mock-locked-model", ptr("mockprov"), "mock-locked-model"},
		{"provider normalized lowercase", "MOCKPROV/mock-model", ptr("mockprov"), "mock-model"},
		{"extra slashes preserved in model", "a/b/c", ptr("a"), "b/c"},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			provider, model := ParseModelParam(tc.modelParam)
			if !reflect.DeepEqual(provider, tc.wantProvider) {
				t.Fatalf("provider = %v, want %v", provider, tc.wantProvider)
			}
			if model != tc.wantModel {
				t.Fatalf("model = %q, want %q", model, tc.wantModel)
			}
		})
	}
}

func TestIsAuthlessProvider(t *testing.T) {
	t.Parallel()
	if !IsAuthlessProvider("opencode") {
		t.Fatal("opencode should be authless")
	}
	for _, provider := range []string{"mockprov", "openrouter", "anthropic", "", "OpenCode"} {
		if IsAuthlessProvider(provider) {
			t.Errorf("IsAuthlessProvider(%q) = true, want false", provider)
		}
	}
}

func TestNormalizeAccessMode(t *testing.T) {
	t.Parallel()
	for input, want := range map[string]string{
		"whitelist": "whitelist",
		"blacklist": "blacklist",
		"all":       "all",
		"":          "all",
		"WHITELIST": "all",
	} {
		if got := normalizeAccessMode(input); got != want {
			t.Errorf("normalizeAccessMode(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestIsModelUsableByAccountsHonorsTierRules(t *testing.T) {
	t.Parallel()
	service := &Service{registry: mockRegistry(t)}

	cases := []struct {
		name         string
		availability AccountModelAvailability
		want         bool
	}{
		{
			name: "eligible paid tier",
			availability: AccountModelAvailability{
				AccountCountByProvider:     map[string]int{"mockprov": 1},
				ActiveAccountIDsByProvider: map[string][]string{"mockprov": {"a1"}},
				AccountTierByID:            map[string]string{"a1": "pro"},
			},
			want: true,
		},
		{
			name: "tier alias normalizes to allowed tier",
			availability: AccountModelAvailability{
				AccountCountByProvider:     map[string]int{"mockprov": 1},
				ActiveAccountIDsByProvider: map[string][]string{"mockprov": {"a1"}},
				AccountTierByID:            map[string]string{"a1": "pro_plus"},
			},
			want: true,
		},
		{
			name: "ineligible free tier",
			availability: AccountModelAvailability{
				AccountCountByProvider:     map[string]int{"mockprov": 1},
				ActiveAccountIDsByProvider: map[string][]string{"mockprov": {"a1"}},
				AccountTierByID:            map[string]string{"a1": "free"},
			},
			want: false,
		},
		{
			name: "one of many eligible",
			availability: AccountModelAvailability{
				AccountCountByProvider:       map[string]int{"mockprov": 2},
				ActiveAccountIDsByProvider:   map[string][]string{"mockprov": {"a1", "a2"}},
				AccountTierByID:              map[string]string{"a1": "free", "a2": "power"},
				DisabledCountByProviderModel: map[string]int{"mockprov:" + mockLockedModel: 1},
			},
			want: true,
		},
		{
			name: "all accounts disabled for model",
			availability: AccountModelAvailability{
				AccountCountByProvider:       map[string]int{"mockprov": 1},
				ActiveAccountIDsByProvider:   map[string][]string{"mockprov": {"a1"}},
				AccountTierByID:              map[string]string{"a1": "pro"},
				DisabledCountByProviderModel: map[string]int{"mockprov:" + mockLockedModel: 1},
			},
			want: false,
		},
		{
			name:         "no accounts",
			availability: AccountModelAvailability{},
			want:         false,
		},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			if got := service.IsModelUsableByAccounts(mockLockedModel, tc.availability); got != tc.want {
				t.Fatalf("IsModelUsableByAccounts = %v, want %v", got, tc.want)
			}
		})
	}

	if service.IsModelUsableByAccounts("does-not-exist", AccountModelAvailability{AccountCountByProvider: map[string]int{"mockprov": 1}}) {
		t.Fatal("unknown model should not be usable")
	}
}

func TestIsModelUsableBySharedAccountsHonorsTierRules(t *testing.T) {
	t.Parallel()
	service := &Service{registry: mockRegistry(t)}

	cases := []struct {
		name         string
		availability AccountModelAvailability
		want         bool
	}{
		{
			name: "eligible shared tier",
			availability: AccountModelAvailability{
				SharedAccountCountByProvider: map[string]int{"mockprov": 1},
				SharedAccountTiersByProvider: map[string][]string{"mockprov": {"pro"}},
			},
			want: true,
		},
		{
			name: "ineligible shared tier",
			availability: AccountModelAvailability{
				SharedAccountCountByProvider: map[string]int{"mockprov": 1},
				SharedAccountTiersByProvider: map[string][]string{"mockprov": {"free"}},
			},
			want: false,
		},
		{
			name: "all shared accounts disabled",
			availability: AccountModelAvailability{
				SharedAccountCountByProvider:       map[string]int{"mockprov": 1},
				SharedAccountTiersByProvider:       map[string][]string{"mockprov": {"pro"}},
				SharedDisabledCountByProviderModel: map[string]int{"mockprov:" + mockLockedModel: 1},
			},
			want: false,
		},
		{
			name:         "no shared accounts",
			availability: AccountModelAvailability{},
			want:         false,
		},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			if got := service.IsModelUsableBySharedAccounts(mockLockedModel, tc.availability); got != tc.want {
				t.Fatalf("IsModelUsableBySharedAccounts = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestToSetAndDefaultString(t *testing.T) {
	t.Parallel()
	set := toSet([]string{"a", "b", "a"})
	if len(set) != 2 {
		t.Fatalf("toSet = %v, want 2 entries", set)
	}
	if _, ok := set["a"]; !ok {
		t.Fatalf("toSet missing a: %v", set)
	}
	if got := defaultString("", "fallback"); got != "fallback" {
		t.Fatalf("defaultString empty = %q, want fallback", got)
	}
	if got := defaultString("value", "fallback"); got != "value" {
		t.Fatalf("defaultString value = %q, want value", got)
	}
}

func TestIsModelUsableByAccountsIncludesSharedWhenRequested(t *testing.T) {
	t.Parallel()
	service := &Service{registry: mockRegistry(t)}
	availability := AccountModelAvailability{
		SharedAccountCountByProvider: map[string]int{"mockprov": 1},
		SharedAccountTiersByProvider: map[string][]string{"mockprov": {"pro"}},
	}
	if service.isModelUsableByAccounts(mockLockedModel, availability, false) {
		t.Fatal("shared-only availability should not be usable without includeShared")
	}
	if !service.isModelUsableByAccounts(mockLockedModel, availability, true) {
		t.Fatal("shared-only availability should be usable with includeShared")
	}
}

func ptr(value string) *string { return &value }
