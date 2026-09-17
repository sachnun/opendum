package proxy

import (
	"testing"
	"time"

	appdb "github.com/opendum/opendum/apps/proxy/internal/db"
)

func TestNullableTimeBefore(t *testing.T) {
	t.Parallel()
	now := time.Now()
	earlier := now.Add(-time.Hour)

	if nullableTimeBefore(nil, nil) {
		t.Fatal("nil,nil should be false")
	}
	if !nullableTimeBefore(nil, &now) {
		t.Fatal("nil should sort before a set time")
	}
	if nullableTimeBefore(&now, nil) {
		t.Fatal("set time should not sort before nil")
	}
	if !nullableTimeBefore(&earlier, &now) {
		t.Fatal("earlier should sort before later")
	}
	if nullableTimeBefore(&now, &earlier) {
		t.Fatal("later should not sort before earlier")
	}
}

func TestIsPaidAccountTier(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name     string
		provider string
		tier     *string
		want     bool
	}{
		{"nil tier", "openrouter", nil, false},
		{"kiro pro plus", "kiro", strPtr("pro-plus"), true},
		{"kiro power", "kiro", strPtr("power"), true},
		{"kiro free", "kiro", strPtr("free"), false},
		{"antigravity standard tier", "antigravity", strPtr("standard-tier"), true},
		{"generic plus", "openrouter", strPtr("plus"), true},
		{"generic free", "openrouter", strPtr("free"), false},
		{"generic unknown", "openrouter", strPtr("mystery"), false},
		{"generic trimmed upper", "openrouter", strPtr(" PRO "), true},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			if got := isPaidAccountTier(tc.provider, tc.tier); got != tc.want {
				t.Fatalf("isPaidAccountTier(%q, %v) = %v, want %v", tc.provider, tc.tier, got, tc.want)
			}
		})
	}
}

func TestSortAccountsByProviderPriority(t *testing.T) {
	t.Parallel()
	accounts := []appdb.ProviderAccount{
		{ID: "a", Provider: "kiro", Status: "active"},
		{ID: "b", Provider: "openrouter", Status: "active"},
		{ID: "c", Provider: "zzz", Status: "active"},
		{ID: "d", Provider: "kiro", Status: "failed"},
	}
	sortAccountsByProviderPriority(accounts, []string{"openrouter", "kiro"})

	got := make([]string, len(accounts))
	for i, account := range accounts {
		got[i] = account.ID
	}
	want := []string{"b", "a", "d", "c"}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("order = %v, want %v", got, want)
		}
	}
}

func TestSortAccountsByProviderPriorityBreaksTiesByLastUsed(t *testing.T) {
	t.Parallel()
	now := time.Now()
	accounts := []appdb.ProviderAccount{
		{ID: "used", Provider: "kiro", Status: "active", LastUsedAt: &now},
		{ID: "unused", Provider: "kiro", Status: "active"},
	}
	sortAccountsByProviderPriority(accounts, []string{"kiro"})
	if accounts[0].ID != "unused" || accounts[1].ID != "used" {
		t.Fatalf("order = [%s %s], want [unused used]", accounts[0].ID, accounts[1].ID)
	}
}

func TestPaidFirstOrdersPaidBeforeFree(t *testing.T) {
	t.Parallel()
	free := "free"
	paid := "pro"
	accounts := []appdb.ProviderAccount{
		{ID: "free_1", Provider: "openrouter", Tier: &free},
		{ID: "paid_1", Provider: "openrouter", Tier: &paid},
		{ID: "authless", Provider: "opencode"},
	}
	got := paidFirst(accounts)
	if got[0].ID != "paid_1" {
		t.Fatalf("first = %q, want paid_1", got[0].ID)
	}
	if got[1].ID != "free_1" || got[2].ID != "authless" {
		t.Fatalf("order = [%s %s %s], want [paid_1 free_1 authless]", got[0].ID, got[1].ID, got[2].ID)
	}
}
