package proxy

import (
	"testing"
)

func floatPtr(value float64) *float64  { return &value }
func strPtrValue(value string) *string { return &value }

func TestPerchQuotaGroupsMonthlyAllowanceAndWindows(t *testing.T) {
	payload := perchAccountResponse{
		OK: true,
		Session: perchAccountSession{
			PlanCode: "pilot",
			PlanName: "Starter",
			Entitlements: []perchAccountEntitlement{{
				Key: "usage.monthly_pt",
				ValueJSON: struct {
					Limit *float64 `json:"limit"`
				}{Limit: floatPtr(20000)},
			}},
		},
		UsageMeter: perchUsageMeter{
			MonthlyPt: floatPtr(5000),
			RoostRolling: &perchRollingWindow{
				Enabled:             true,
				Window7dUsd:         floatPtr(3.25),
				Window7dCapUsd:      floatPtr(10),
				Window7dNextFreedAt: strPtrValue("2099-01-02T03:04:05.000Z"),
				Window5hUsd:         floatPtr(2),
				Window5hCapUsd:      floatPtr(2),
				Window5hNextFreedAt: strPtrValue("2099-01-02T00:00:00.000Z"),
			},
		},
		CreditBalancePt: floatPtr(750),
	}

	groups := perchQuotaGroups(payload)
	if len(groups) != 4 {
		t.Fatalf("groups = %d, want 4: %#v", len(groups), groups)
	}

	monthly := quotaGroupByName(groups, "monthly-allowance")
	if monthly == nil {
		t.Fatal("monthly-allowance group missing")
	}
	if monthly.RemainingRequests != 15000 || monthly.MaxRequests != 20000 || monthly.UsedRequests != 5000 {
		t.Fatalf("monthly group values = remaining %v of %v (used %v)", monthly.RemainingRequests, monthly.MaxRequests, monthly.UsedRequests)
	}
	if monthly.RemainingFraction < 0.749 || monthly.RemainingFraction > 0.751 {
		t.Fatalf("monthly remaining fraction = %v", monthly.RemainingFraction)
	}
	if monthly.PercentUsed != 25 {
		t.Fatalf("monthly percent used = %d", monthly.PercentUsed)
	}

	weekly := quotaGroupByName(groups, "fair-use-7d")
	if weekly == nil {
		t.Fatal("fair-use-7d group missing")
	}
	if weekly.ResetTimeIso == nil || weekly.ResetInHuman == nil {
		t.Fatalf("7d window should carry a reset time, got %#v", weekly)
	}

	fiveHour := quotaGroupByName(groups, "fair-use-5h")
	if fiveHour == nil {
		t.Fatal("fair-use-5h group missing")
	}
	if !fiveHour.IsExhausted || fiveHour.RemainingFraction != 0 {
		t.Fatalf("5h window should be exhausted, got %#v", fiveHour)
	}

	credits := quotaGroupByName(groups, "credits")
	if credits == nil || credits.RemainingRequests != 750 {
		t.Fatalf("credits group = %#v", credits)
	}
}

func TestPerchQuotaGroupsFallsBackToStarterAllowance(t *testing.T) {
	payload := perchAccountResponse{
		OK:         true,
		UsageMeter: perchUsageMeter{MonthlyUsd: floatPtr(2.5)},
	}
	groups := perchQuotaGroups(payload)
	if len(groups) != 1 {
		t.Fatalf("groups = %d, want 1: %#v", len(groups), groups)
	}
	monthly := groups[0]
	if monthly.MaxRequests != perchMonthlyPTFallback {
		t.Fatalf("fallback limit = %v", monthly.MaxRequests)
	}
	if monthly.UsedRequests != 2500 {
		t.Fatalf("monthly USD fallback used = %v", monthly.UsedRequests)
	}
}
