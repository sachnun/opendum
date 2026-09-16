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
    "deepseek/deepseek-v4-flash": {"model": "deepseek/deepseek-v4-flash", "limit": 6, "pool": "limited", "poolLabel": "Daily", "resetAt": "2026-09-16T07:00:00.000Z", "recentCount": 0.1},
    "mimo/mimo-v2.5": {"model": "mimo/mimo-v2.5", "limit": 6, "pool": "limited", "poolLabel": "Daily", "resetAt": "2026-09-16T07:00:00.000Z", "recentCount": 0.1},
    "upstage/solar-pro4": {"model": "upstage/solar-pro4", "limit": 6, "pool": "limited", "poolLabel": "Daily", "resetAt": "2026-09-16T07:00:00.000Z", "recentCount": 0.1}
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

func TestFreebuffQuotaGroupsParseSessionPayload(t *testing.T) {
	groups := freebuffQuotaGroups(decodeFreebuffQuota(t, freebuffQuotaSample))
	if len(groups) != 4 {
		t.Fatalf("groups = %d, want 4: %#v", len(groups), groups)
	}

	freebucks := groups[0]
	if freebucks.Name != "freebucks-daily" || freebucks.DisplayName != "Freebucks" {
		t.Fatalf("freebucks group = %#v", freebucks)
	}
	if freebucks.RemainingRequests != 10 || freebucks.MaxRequests != 25 || freebucks.UsedRequests != 15 {
		t.Fatalf("freebucks numbers = %v/%v/%v, want 10/25/15", freebucks.RemainingRequests, freebucks.MaxRequests, freebucks.UsedRequests)
	}
	if math.Abs(freebucks.RemainingFraction-0.4) > 1e-9 {
		t.Fatalf("freebucks fraction = %v, want 0.4", freebucks.RemainingFraction)
	}
	if freebucks.PercentUsed != 60 {
		t.Fatalf("freebucks percent used = %d, want 60", freebucks.PercentUsed)
	}
	if freebucks.ResetTimeIso == nil || *freebucks.ResetTimeIso != "2026-09-16T07:00:00.000Z" {
		t.Fatalf("freebucks reset = %#v", freebucks.ResetTimeIso)
	}
	if freebucks.ResetInHuman == nil {
		t.Fatal("freebucks group is missing the human reset time")
	}
	if freebucks.IsExhausted {
		t.Fatal("freebucks group should not be exhausted with 10 remaining")
	}

	wantModels := []string{"deepseek/deepseek-v4-flash", "mimo/mimo-v2.5", "upstage/solar-pro4"}
	for index, model := range wantModels {
		group := groups[index+1]
		if group.Name != "sessions-"+model || group.DisplayName != model {
			t.Fatalf("model group %d = %#v, want %q", index, group, model)
		}
		if group.MaxRequests != 6 {
			t.Fatalf("%s max = %v, want 6", model, group.MaxRequests)
		}
		if group.RemainingRequests != 5.9 {
			t.Fatalf("%s remaining = %v, want 5.9", model, group.RemainingRequests)
		}
		if math.Abs(group.RemainingFraction-5.9/6) > 1e-9 {
			t.Fatalf("%s fraction = %v, want %v", model, group.RemainingFraction, 5.9/6)
		}
		if group.PercentUsed != 2 {
			t.Fatalf("%s percent used = %d, want 2", model, group.PercentUsed)
		}
	}
}

func TestFreebuffQuotaGroupsSkipUnusableEntries(t *testing.T) {
	payload := decodeFreebuffQuota(t, `{
	  "freebucks": {"daily": {"limit": 0, "remaining": 0}},
	  "rateLimitsByModel": {
	    "a/zero-limit": {"limit": 0, "recentCount": 0},
	    "a/exhausted": {"limit": 4, "recentCount": 4, "resetAt": ""}
	  }
	}`)
	groups := freebuffQuotaGroups(payload)
	if len(groups) != 1 {
		t.Fatalf("groups = %d, want 1: %#v", len(groups), groups)
	}
	if groups[0].DisplayName != "a/exhausted" || !groups[0].IsExhausted || groups[0].RemainingFraction != 0 {
		t.Fatalf("exhausted group = %#v", groups[0])
	}
	if groups[0].ResetTimeIso != nil || groups[0].ResetInHuman != nil {
		t.Fatalf("exhausted group should not carry a reset time: %#v", groups[0])
	}

	if empty := freebuffQuotaGroups(decodeFreebuffQuota(t, `{}`)); len(empty) != 0 {
		t.Fatalf("empty payload groups = %#v, want none", empty)
	}
}
