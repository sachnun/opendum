package proxy

import (
	"errors"
	"reflect"
	"testing"
	"time"

	appdb "github.com/opendum/opendum/apps/proxy/internal/db"
	"github.com/opendum/opendum/apps/proxy/internal/sessionaffinity"
)

func TestEffectiveUnhealthyCountDecaysAfterIdleIntervals(t *testing.T) {
	now := time.Date(2026, 5, 13, 12, 0, 0, 0, time.UTC)
	lastRequestAt := now.Add(-31 * time.Minute)
	health := appdb.ProviderAccountModelHealth{ConsecutiveErrors: 5, UnhealthyCountUpdatedAt: &lastRequestAt}

	if got := effectiveUnhealthyCount(health, now); got != 2 {
		t.Fatalf("effective unhealthy count = %d, want 2", got)
	}
}

func TestEffectiveUnhealthyCountDoesNotDecayBeforeIdleInterval(t *testing.T) {
	now := time.Date(2026, 5, 13, 12, 0, 0, 0, time.UTC)
	lastRequestAt := now.Add(-9 * time.Minute)
	health := appdb.ProviderAccountModelHealth{ConsecutiveErrors: 5, UnhealthyCountUpdatedAt: &lastRequestAt}

	if got := effectiveUnhealthyCount(health, now); got != 5 {
		t.Fatalf("effective unhealthy count = %d, want 5", got)
	}
}

func TestModelHealthStatusStartsDegradedAtTwo(t *testing.T) {
	if got := modelHealthStatus(1); got != "active" {
		t.Fatalf("status for 1 unhealthy = %q, want active", got)
	}
	if got := modelHealthStatus(2); got != "degraded" {
		t.Fatalf("status for 2 unhealthy = %q, want degraded", got)
	}
}

func TestCooldownRecoveryCountReducesRoundedThirtyPercent(t *testing.T) {
	tests := map[int]int{1: 1, 2: 1, 3: 2, 5: 3, 10: 7}
	for input, want := range tests {
		if got := cooldownRecoveryCount(input); got != want {
			t.Fatalf("cooldownRecoveryCount(%d) = %d, want %d", input, got, want)
		}
	}
}

func TestSuccessRecoveryCountReducesUnhealthyCount(t *testing.T) {
	now := time.Date(2026, 5, 13, 12, 0, 0, 0, time.UTC)
	lastRequestAt := now.Add(-9 * time.Minute)
	lastErrorCode := 429
	health := appdb.ProviderAccountModelHealth{ConsecutiveErrors: 2, LastErrorCode: &lastErrorCode, UnhealthyCountUpdatedAt: &lastRequestAt}

	if got := successRecoveryCount(health, now); got != 1 {
		t.Fatalf("successRecoveryCount() = %d, want 1", got)
	}
}

func TestSuccessRecoveryCountKeepsClientErrors(t *testing.T) {
	now := time.Date(2026, 5, 13, 12, 0, 0, 0, time.UTC)
	lastRequestAt := now.Add(-9 * time.Minute)
	lastErrorCode := 400
	health := appdb.ProviderAccountModelHealth{ConsecutiveErrors: 2, LastErrorCode: &lastErrorCode, UnhealthyCountUpdatedAt: &lastRequestAt}

	if got := successRecoveryCount(health, now); got != 2 {
		t.Fatalf("successRecoveryCount() = %d, want 2", got)
	}
}

func TestSuccessRecoveryCountDoesNotGoNegative(t *testing.T) {
	now := time.Date(2026, 5, 13, 12, 0, 0, 0, time.UTC)
	health := appdb.ProviderAccountModelHealth{ConsecutiveErrors: 0}

	if got := successRecoveryCount(health, now); got != 0 {
		t.Fatalf("successRecoveryCount() = %d, want 0", got)
	}
}

func TestPrioritizeAccountsTreatsCodexPaidPlansAsPaid(t *testing.T) {
	plus := "plus"
	pro := "pro"
	prolite := "prolite"
	businessUsageBased := "self_serve_business_usage_based"
	enterpriseUsageBased := "enterprise_cbp_usage_based"
	healthcare := "hc"
	free := "free"
	accounts := []appdb.ProviderAccount{
		{ID: "free-codex", Provider: "codex", Tier: &free},
		{ID: "plus-codex", Provider: "codex", Tier: &plus},
		{ID: "prolite-codex", Provider: "codex", Tier: &prolite},
		{ID: "unknown-codex", Provider: "codex"},
		{ID: "business-usage-codex", Provider: "codex", Tier: &businessUsageBased},
		{ID: "pro-codex", Provider: "codex", Tier: &pro},
		{ID: "enterprise-usage-codex", Provider: "codex", Tier: &enterpriseUsageBased},
		{ID: "hc-codex", Provider: "codex", Tier: &healthcare},
	}

	prioritized := prioritizeAccounts(accounts, false, nil)
	ids := make([]string, 0, len(prioritized))
	for _, account := range prioritized {
		ids = append(ids, account.ID)
	}
	want := []string{"plus-codex", "prolite-codex", "business-usage-codex", "pro-codex", "enterprise-usage-codex", "hc-codex", "free-codex", "unknown-codex"}
	if !reflect.DeepEqual(ids, want) {
		t.Fatalf("prioritized ids = %#v, want %#v", ids, want)
	}
}

func TestAntigravityMaxRequestsNormalizesStoredTierAliases(t *testing.T) {
	if got := antigravityMaxRequests("claude-opus-4-6", "paid"); got != 150 {
		t.Fatalf("paid max requests = %v, want 150", got)
	}
	if got := antigravityMaxRequests("claude-opus-4-6", "free"); got != 50 {
		t.Fatalf("free max requests = %v, want 50", got)
	}
}

func TestPrioritizeAccountsTreatsKiroPaidPlansAsPaid(t *testing.T) {
	free := "free"
	pro := "pro"
	proPlus := "pro-plus"
	power := "power"
	accounts := []appdb.ProviderAccount{
		{ID: "free-kiro", Provider: "kiro", Tier: &free},
		{ID: "pro-kiro", Provider: "kiro", Tier: &pro},
		{ID: "unknown-kiro", Provider: "kiro"},
		{ID: "pro-plus-kiro", Provider: "kiro", Tier: &proPlus},
		{ID: "power-kiro", Provider: "kiro", Tier: &power},
	}

	prioritized := prioritizeAccounts(accounts, false, nil)
	ids := make([]string, 0, len(prioritized))
	for _, account := range prioritized {
		ids = append(ids, account.ID)
	}
	want := []string{"pro-kiro", "pro-plus-kiro", "power-kiro", "free-kiro", "unknown-kiro"}
	if !reflect.DeepEqual(ids, want) {
		t.Fatalf("prioritized ids = %#v, want %#v", ids, want)
	}
}

func TestPrioritizeAccountsUsesProviderSpecificPaidTiers(t *testing.T) {
	standardTier := "standard-tier"
	team := "team"
	accounts := []appdb.ProviderAccount{
		{ID: "team-antigravity", Provider: "antigravity", Tier: &team},
		{ID: "standard-antigravity", Provider: "antigravity", Tier: &standardTier},
	}

	prioritized := prioritizeAccounts(accounts, false, nil)
	ids := make([]string, 0, len(prioritized))
	for _, account := range prioritized {
		ids = append(ids, account.ID)
	}
	want := []string{"standard-antigravity", "team-antigravity"}
	if !reflect.DeepEqual(ids, want) {
		t.Fatalf("prioritized ids = %#v, want %#v", ids, want)
	}
}

func TestSessionAffinityPrefersStickyAccount(t *testing.T) {
	free := "free"
	accounts := []appdb.ProviderAccount{
		{ID: "zm-1", Provider: "zenmux", Tier: &free},
		{ID: "zm-2", Provider: "zenmux", Tier: &free},
		{ID: "zm-3", Provider: "zenmux", Tier: &free},
	}
	prioritized := prioritizeAccounts(accounts, false, nil)
	if prioritized[0].ID != "zm-1" {
		t.Fatalf("baseline first = %q, want zm-1", prioritized[0].ID)
	}
	sticky := "zm-3"
	reordered := sessionaffinity.Prefer(prioritized, func(a appdb.ProviderAccount) bool { return a.ID == sticky })
	if reordered[0].ID != sticky {
		t.Fatalf("after Prefer first = %q, want %q", reordered[0].ID, sticky)
	}
	if len(reordered) != len(accounts) {
		t.Fatalf("reordered len = %d, want %d", len(reordered), len(accounts))
	}
	seen := map[string]int{}
	for i, a := range reordered {
		seen[a.ID] = i
	}
	if len(seen) != len(accounts) {
		t.Fatalf("reordered contains duplicates: %v", reordered)
	}
	if reordered[1].ID != "zm-1" || reordered[2].ID != "zm-2" {
		t.Fatalf("remaining order = %v, want [zm-1 zm-2] after sticky", reordered[1:])
	}
}

func TestSessionAffinityPreferNoOpWhenStickyExcluded(t *testing.T) {
	free := "free"
	accounts := []appdb.ProviderAccount{
		{ID: "zm-1", Provider: "zenmux", Tier: &free},
		{ID: "zm-2", Provider: "zenmux", Tier: &free},
	}
	prioritized := prioritizeAccounts(accounts, false, nil)
	sticky := "zm-cooling-down"
	reordered := sessionaffinity.Prefer(prioritized, func(a appdb.ProviderAccount) bool { return a.ID == sticky })
	if reordered[0].ID != "zm-1" || reordered[1].ID != "zm-2" {
		t.Fatalf("no-match Prefer = %v, want unchanged [zm-1 zm-2]", reordered)
	}
}

func TestChooseAccountPicksFirstNonDegradedAndStopsEarly(t *testing.T) {
	accounts := []appdb.ProviderAccount{{ID: "a"}, {ID: "b"}, {ID: "c"}}
	statuses := map[string]string{"a": "degraded", "b": "active", "c": "active"}
	probed := []string{}
	got, has, err := chooseAccount(accounts, func(a appdb.ProviderAccount) (bool, string, bool, error) {
		probed = append(probed, a.ID)
		status, ok := statuses[a.ID]
		return false, status, ok, nil
	})
	if err != nil || !has || got == nil || got.ID != "b" {
		t.Fatalf("got %v has=%v err=%v, want b", got, has, err)
	}
	if !reflect.DeepEqual(probed, []string{"a", "b"}) {
		t.Fatalf("probed %v, want only [a b] so the walk stops after the first usable account", probed)
	}
}

func TestChooseAccountFallsBackToFirstDegraded(t *testing.T) {
	accounts := []appdb.ProviderAccount{{ID: "a"}, {ID: "b"}}
	got, has, err := chooseAccount(accounts, func(a appdb.ProviderAccount) (bool, string, bool, error) {
		return false, "degraded", true, nil
	})
	if err != nil || !has || got == nil || got.ID != "a" {
		t.Fatalf("got %v has=%v err=%v, want a", got, has, err)
	}
}

func TestChooseAccountSkipsCoolingDown(t *testing.T) {
	accounts := []appdb.ProviderAccount{{ID: "a"}, {ID: "b"}}
	got, has, err := chooseAccount(accounts, func(a appdb.ProviderAccount) (bool, string, bool, error) {
		if a.ID == "a" {
			return true, "", false, nil
		}
		return false, "active", true, nil
	})
	if err != nil || !has || got == nil || got.ID != "b" {
		t.Fatalf("got %v has=%v err=%v, want b", got, has, err)
	}
}

func TestChooseAccountTreatsMissingHealthAsUsable(t *testing.T) {
	accounts := []appdb.ProviderAccount{{ID: "a"}}
	got, has, err := chooseAccount(accounts, func(a appdb.ProviderAccount) (bool, string, bool, error) {
		return false, "", false, nil
	})
	if err != nil || !has || got == nil || got.ID != "a" {
		t.Fatalf("got %v has=%v err=%v, want a", got, has, err)
	}
}

func TestChooseAccountReturnsNoneWhenAllCoolingDown(t *testing.T) {
	accounts := []appdb.ProviderAccount{{ID: "a"}, {ID: "b"}}
	got, has, err := chooseAccount(accounts, func(a appdb.ProviderAccount) (bool, string, bool, error) {
		return true, "", false, nil
	})
	if err != nil || has || got != nil {
		t.Fatalf("got %v has=%v err=%v, want nil false nil", got, has, err)
	}
}

func TestChooseAccountPropagatesProbeError(t *testing.T) {
	accounts := []appdb.ProviderAccount{{ID: "a"}}
	wantErr := errors.New("boom")
	got, has, err := chooseAccount(accounts, func(a appdb.ProviderAccount) (bool, string, bool, error) {
		return false, "", false, wantErr
	})
	if !errors.Is(err, wantErr) || !has || got != nil {
		t.Fatalf("got %v has=%v err=%v, want propagated error", got, has, err)
	}
}
