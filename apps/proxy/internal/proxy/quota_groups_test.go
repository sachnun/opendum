package proxy

import "testing"

func findQuotaGroup(groups []quotaGroupDisplay, name string) *quotaGroupDisplay {
	for i := range groups {
		if groups[i].Name == name {
			return &groups[i]
		}
	}
	return nil
}

func TestOpenRouterGroupsAccountCredits(t *testing.T) {
	t.Parallel()
	groups := openRouterGroups(map[string]any{}, map[string]any{"total_credits": 10.0, "total_usage": 4.0})
	if len(groups) != 1 {
		t.Fatalf("groups = %v, want one account-credits group", groups)
	}
	group := &groups[0]
	if group.Name != "account-credits" {
		t.Fatalf("name = %q", group.Name)
	}
	if group.RemainingFraction != 0.6 || group.PercentUsed != 40 {
		t.Fatalf("fraction/percent = %v/%d, want 0.6/40", group.RemainingFraction, group.PercentUsed)
	}
	if group.RemainingRequests != 6 || group.MaxRequests != 10 || group.UsedRequests != 4 {
		t.Fatalf("requests = %v/%v/%v, want 6/10/4", group.RemainingRequests, group.MaxRequests, group.UsedRequests)
	}
	if group.RemainingLabel == nil || *group.RemainingLabel != "$6.00 / $10.00" {
		t.Fatalf("label = %v, want $6.00 / $10.00", group.RemainingLabel)
	}
	if group.IsExhausted {
		t.Fatal("credits should not be exhausted")
	}
}

func TestOpenRouterGroupsExhaustedCredits(t *testing.T) {
	t.Parallel()
	groups := openRouterGroups(map[string]any{}, map[string]any{"total_credits": 10.0, "total_usage": 12.0})
	group := findQuotaGroup(groups, "account-credits")
	if group == nil {
		t.Fatal("account-credits group missing")
	}
	if group.RemainingFraction != 0 || !group.IsExhausted {
		t.Fatalf("exhausted group = %+v", group)
	}
}

func TestOpenRouterGroupsKeyLimit(t *testing.T) {
	t.Parallel()
	groups := openRouterGroups(map[string]any{"limit": 100.0, "limit_remaining": 25.0, "usage": 75.0}, map[string]any{})
	group := findQuotaGroup(groups, "key-limit")
	if group == nil {
		t.Fatalf("key-limit group missing: %v", groups)
	}
	if group.RemainingFraction != 0.25 || group.PercentUsed != 75 {
		t.Fatalf("fraction/percent = %v/%d, want 0.25/75", group.RemainingFraction, group.PercentUsed)
	}
	if group.RemainingLabel == nil || *group.RemainingLabel != "$25.00 / $100.00" {
		t.Fatalf("label = %v", group.RemainingLabel)
	}
}

func TestOpenRouterGroupsCreditsBeforeKeyLimit(t *testing.T) {
	t.Parallel()
	groups := openRouterGroups(
		map[string]any{"limit": 100.0, "limit_remaining": 25.0, "usage": 75.0},
		map[string]any{"total_credits": 10.0, "total_usage": 4.0},
	)
	if len(groups) != 2 {
		t.Fatalf("groups = %d, want 2", len(groups))
	}
	if groups[0].Name != "account-credits" || groups[1].Name != "key-limit" {
		t.Fatalf("order = %q, %q", groups[0].Name, groups[1].Name)
	}
}

func TestOpenRouterGroupsDailyUsageFallback(t *testing.T) {
	t.Parallel()
	groups := openRouterGroups(map[string]any{"usage_daily": 2.5}, map[string]any{})
	if len(groups) != 1 || groups[0].Name != "daily-usage" {
		t.Fatalf("groups = %v, want daily-usage", groups)
	}
	if groups[0].RemainingLabel == nil || *groups[0].RemainingLabel != "$2.50" {
		t.Fatalf("label = %v, want $2.50", groups[0].RemainingLabel)
	}
	if !groups[0].IsEstimated {
		t.Fatal("daily usage should be estimated")
	}
}

func TestOpenRouterGroupsKeyStatusFallback(t *testing.T) {
	t.Parallel()
	active := openRouterGroups(map[string]any{}, map[string]any{})
	if len(active) != 1 || active[0].Name != "key-status" {
		t.Fatalf("groups = %v, want key-status", active)
	}
	if active[0].RemainingLabel == nil || *active[0].RemainingLabel != "active" {
		t.Fatalf("default label = %v, want active", active[0].RemainingLabel)
	}

	free := openRouterGroups(map[string]any{"is_free_tier": true}, map[string]any{})
	if free[0].RemainingLabel == nil || *free[0].RemainingLabel != "free tier" {
		t.Fatalf("free label = %v, want free tier", free[0].RemainingLabel)
	}
}

func TestOpenRouterGroupsZeroCreditsFallsThrough(t *testing.T) {
	t.Parallel()
	groups := openRouterGroups(map[string]any{"usage_daily": 1.0}, map[string]any{"total_credits": 0.0, "total_usage": 5.0})
	if len(groups) != 1 || groups[0].Name != "daily-usage" {
		t.Fatalf("groups = %v, want daily-usage when credits total is zero", groups)
	}
}
