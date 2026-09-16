package proxy

import (
	"encoding/json"
	"math"
	"testing"
)

const freebuffQuotaSample = `{
  "status": "none",
  "accessTier": "limited",
  "message": "Call POST to start a free session.",
  "freebucks": {
    "balance": 10,
    "daily": {"limit": 25, "spent": 15, "remaining": 10, "resetAt": "2026-09-16T07:00:00.000Z", "resetTimeZone": "America/Los_Angeles"},
    "wallet": {"balance": 0, "monthlyBonus": 0}
  },
  "rateLimitsByModel": {
    "deepseek/deepseek-v4-flash": {"model": "deepseek/deepseek-v4-flash", "limit": 6, "pool": "limited", "poolLabel": "Daily", "resetAt": "2026-09-16T07:00:00.000Z", "recentCount": 0.1}
  }
}`

func decodeFreebuffQuota(t *testing.T, raw string) freebuffQuotaSession {
	t.Helper()
	var payload freebuffQuotaSession
	if err := json.Unmarshal([]byte(raw), &payload); err != nil {
		t.Fatalf("decode quota payload: %v", err)
	}
	return payload
}

func TestFreebuffQuotaGroupsReportDailyFreebucks(t *testing.T) {
	groups := freebuffQuotaGroups(decodeFreebuffQuota(t, freebuffQuotaSample))
	if len(groups) != 1 {
		t.Fatalf("groups = %d, want 1: %#v", len(groups), groups)
	}

	group := groups[0]
	if group.Name != "freebucks-daily" || group.DisplayName != "Freebucks" {
		t.Fatalf("group = %#v", group)
	}
	if group.RemainingRequests != 10 || group.MaxRequests != 25 || group.UsedRequests != 15 {
		t.Fatalf("numbers = %v/%v/%v, want 10/25/15", group.RemainingRequests, group.MaxRequests, group.UsedRequests)
	}
	if math.Abs(group.RemainingFraction-0.4) > 1e-9 {
		t.Fatalf("fraction = %v, want 0.4", group.RemainingFraction)
	}
	if group.PercentUsed != 60 {
		t.Fatalf("percent used = %d, want 60", group.PercentUsed)
	}
	if group.ResetTimeIso == nil || *group.ResetTimeIso != "2026-09-16T07:00:00.000Z" {
		t.Fatalf("reset = %#v", group.ResetTimeIso)
	}
	if group.ResetInHuman == nil {
		t.Fatal("group is missing the human reset time")
	}
	if group.IsExhausted {
		t.Fatal("group should not be exhausted with 10 remaining")
	}
}

func TestFreebuffQuotaGroupsHandleMissingOrSpentFreebucks(t *testing.T) {
	if groups := freebuffQuotaGroups(decodeFreebuffQuota(t, `{}`)); len(groups) != 0 {
		t.Fatalf("empty payload groups = %#v, want none", groups)
	}

	spent := decodeFreebuffQuota(t, `{"freebucks": {"daily": {"limit": 25, "spent": 25, "remaining": 0}}}`)
	groups := freebuffQuotaGroups(spent)
	if len(groups) != 1 {
		t.Fatalf("groups = %d, want 1: %#v", len(groups), groups)
	}
	if !groups[0].IsExhausted || groups[0].RemainingFraction != 0 {
		t.Fatalf("exhausted group = %#v", groups[0])
	}
	if groups[0].ResetTimeIso != nil || groups[0].ResetInHuman != nil {
		t.Fatalf("group without resetAt should not carry a reset time: %#v", groups[0])
	}
}
