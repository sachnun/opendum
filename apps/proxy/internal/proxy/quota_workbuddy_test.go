package proxy

import (
	"testing"
)

func TestWorkbuddyQuotaGroupsUseFriendlyNames(t *testing.T) {
	summary := workbuddyQuotaSummary{Packages: []workbuddyQuotaPackage{
		{PackageCode: "TCACA_code_006_DbXS0lrypC", CycleTotalCapacity: "250", CycleRemainCapacity: "29.57", CycleUsedCapacity: "220.43"},
		{PackageCode: "TCACA_code_035_ArVxJcGDsm", CycleTotalCapacity: "100", CycleRemainCapacity: "100", CycleUsedCapacity: "0"},
	}}
	details := map[string]workbuddyPackageDetail{
		"TCACA_code_006_DbXS0lrypC": {PackageCode: "TCACA_code_006_DbXS0lrypC", PackageName: "Bonus Pack", CycleEndTime: "2026-09-25 10:21:38"},
		"TCACA_code_035_ArVxJcGDsm": {PackageCode: "TCACA_code_035_ArVxJcGDsm", PackageName: "Free Plan Subscription", CycleEndTime: "2026-09-30 23:59:59"},
	}

	groups := workbuddyQuotaGroups(summary, details)
	if len(groups) != 2 {
		t.Fatalf("groups = %d, want 2: %#v", len(groups), groups)
	}
	if groups[0].DisplayName != "Bonus Pack" {
		t.Fatalf("bonus DisplayName = %q, want %q", groups[0].DisplayName, "Bonus Pack")
	}
	if groups[1].DisplayName != "Free Plan" {
		t.Fatalf("free DisplayName = %q, want %q", groups[1].DisplayName, "Free Plan")
	}
	if groups[0].DisplayName == "DbXS0lrypC" || groups[1].DisplayName == "ArVxJcGDsm" {
		t.Fatalf("DisplayName still uses random suffix: %#v", groups)
	}
	if groups[0].ResetTimeIso == nil || groups[0].ResetInHuman == nil {
		t.Fatalf("bonus group should carry reset time, got %#v", groups[0])
	}
	if groups[0].RemainingFraction < 0.11 || groups[0].RemainingFraction > 0.13 {
		t.Fatalf("bonus remaining fraction = %v, want ~0.12", groups[0].RemainingFraction)
	}
}

func TestWorkbuddyDisplayNameFallsBackWithoutDetails(t *testing.T) {
	if got := workbuddyDisplayName("TCACA_code_006_DbXS0lrypC", ""); got != "Bonus Pack" {
		t.Fatalf("fallback bonus = %q, want Bonus Pack", got)
	}
	if got := workbuddyDisplayName("TCACA_code_035_ArVxJcGDsm", ""); got != "Free Plan" {
		t.Fatalf("fallback free = %q, want Free Plan", got)
	}
	if got := workbuddyDisplayName("TCACA_code_006_DbXS0lrypC", "Bonus Pack"); got != "Bonus Pack" {
		t.Fatalf("detail bonus = %q, want Bonus Pack", got)
	}
	if got := workbuddyDisplayName("TCACA_code_035_ArVxJcGDsm", "Free Plan Subscription"); got != "Free Plan" {
		t.Fatalf("detail free = %q, want Free Plan", got)
	}
}
