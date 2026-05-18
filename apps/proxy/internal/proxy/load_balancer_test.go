package proxy

import (
	"reflect"
	"testing"
	"time"

	appdb "github.com/opendum/opendum/apps/proxy/internal/db"
)

func TestEffectiveHealthStatusDowngradesExpiredFailed(t *testing.T) {
	now := time.Date(2026, 5, 13, 12, 0, 0, 0, time.UTC)
	changedAt := now.Add(-failedCooldown)
	health := effectiveHealthStatus(appdb.ProviderAccountModelHealth{Status: "failed", StatusChangedAt: &changedAt}, now)

	if health.Status != "degraded" {
		t.Fatalf("expired failed health status = %q, want degraded", health.Status)
	}
}

func TestSuccessRecoveryState(t *testing.T) {
	tests := []struct {
		name       string
		status     string
		errors     int
		wantErrors int
		wantStatus string
		wantUpdate bool
	}{
		{name: "degraded counts down", status: "degraded", errors: 3, wantErrors: 2, wantStatus: "degraded", wantUpdate: true},
		{name: "degraded recovers", status: "degraded", errors: 1, wantErrors: 0, wantStatus: "active", wantUpdate: true},
		{name: "active only counts down", status: "active", errors: 2, wantErrors: 1, wantStatus: "active", wantUpdate: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			gotErrors, gotStatus, gotUpdate := successRecoveryState(tt.status, tt.errors)
			if gotErrors != tt.wantErrors || gotStatus != tt.wantStatus || gotUpdate != tt.wantUpdate {
				t.Fatalf("successRecoveryState(%q, %d) = (%d, %q, %v), want (%d, %q, %v)", tt.status, tt.errors, gotErrors, gotStatus, gotUpdate, tt.wantErrors, tt.wantStatus, tt.wantUpdate)
			}
		})
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
