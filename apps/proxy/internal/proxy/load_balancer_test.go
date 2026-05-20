package proxy

import (
	"reflect"
	"testing"
	"time"

	appdb "github.com/opendum/opendum/apps/proxy/internal/db"
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

func TestKiroTierNormalizesSubscriptionTypeAndTitle(t *testing.T) {
	tests := []struct {
		name string
		sub  map[string]any
		want string
	}{
		{name: "free type", sub: map[string]any{"type": "Q_DEVELOPER_STANDALONE_FREE"}, want: "free"},
		{name: "pro type", sub: map[string]any{"type": "Q_DEVELOPER_STANDALONE_PRO"}, want: "pro"},
		{name: "pro plus type", sub: map[string]any{"type": "Q_DEVELOPER_STANDALONE_PRO_PLUS"}, want: "pro-plus"},
		{name: "power type", sub: map[string]any{"type": "Q_DEVELOPER_STANDALONE_POWER"}, want: "power"},
		{name: "pro plus title", sub: map[string]any{"subscriptionTitle": "Kiro Pro+"}, want: "pro-plus"},
		{name: "power title", sub: map[string]any{"subscriptionTitle": "Kiro Power"}, want: "power"},
		{name: "free title", sub: map[string]any{"subscriptionTitle": "Kiro Free"}, want: "free"},
		{name: "unknown title", sub: map[string]any{"subscriptionTitle": "Custom Team Tier"}, want: "custom-team-tier"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := kiroTier(map[string]any{"subscriptionInfo": tt.sub})
			if got != tt.want {
				t.Fatalf("kiroTier() = %q, want %q", got, tt.want)
			}
		})
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
