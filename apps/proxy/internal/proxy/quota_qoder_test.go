package proxy

import (
	"testing"
	"time"
)

func TestQuotaBlockedUntilDetectsQoderExhaustion(t *testing.T) {
	now := time.Date(2026, 9, 11, 12, 0, 0, 0, time.UTC)

	// Captured from production: qoder answers 403 with the pricing nudge.
	body := `{"error":{"message":"Qoder: {\"pricingUrl\":\"https://qoder.com/pricing?client=qoder\"}"}}`

	until, ok := quotaBlockedUntil("qoder", 403, body, now)
	if !ok {
		t.Fatal("pricing block should be detected")
	}
	if got := until.Sub(now); got != qoderQuotaLockDuration {
		t.Fatalf("lock duration = %s, want %s", got, qoderQuotaLockDuration)
	}
}

func TestQuotaBlockedUntilDetectsQoderCode112(t *testing.T) {
	now := time.Now()
	body := `{"error":{"message":"Qoder: {\"code\":\"112\",\"message\":\"quota\"}"}}`

	until, ok := quotaBlockedUntil("qoder", 403, body, now)
	if !ok {
		t.Fatal("code 112 should be detected as exhausted")
	}
	if got := until.Sub(now); got != qoderQuotaLockDuration {
		t.Fatalf("lock duration = %s, want %s", got, qoderQuotaLockDuration)
	}
}

func TestQuotaBlockedUntilTreatsThrottleAsShortCooldown(t *testing.T) {
	now := time.Now()
	body := `{"error":{"message":"Qoder: {\"code\":\"10605\"}"}}`

	until, ok := quotaBlockedUntil("qoder", 429, body, now)
	if !ok {
		t.Fatal("code 10605 should be detected")
	}
	if got := until.Sub(now); got != qoderQuotaThrottleDuration {
		t.Fatalf("cooldown = %s, want %s (throttle must not lock for long)", got, qoderQuotaThrottleDuration)
	}
}

func TestQuotaBlockedUntilIgnoresNonQuotaFailures(t *testing.T) {
	now := time.Now()
	cases := []struct {
		name     string
		provider string
		status   int
		body     string
	}{
		{"other provider", "hyper", 403, `{"code":"112"}`},
		{"plain 403 without a billing signal", "qoder", 403, `{"error":{"message":"forbidden"}}`},
		{"success status", "qoder", 200, `{"code":"112"}`},
		{"empty body", "qoder", 403, ""},
		{"unauthorized", "qoder", 401, `{"code":"112"}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, ok := quotaBlockedUntil(tc.provider, tc.status, tc.body, now); ok {
				t.Fatalf("unexpected quota lock for %#v", tc)
			}
		})
	}
}

func TestQoderBodyCodeHandlesNestedAndNumericShapes(t *testing.T) {
	cases := map[string]string{
		`{"code":"112"}`:                   "112",
		`{"code":112}`:                     "112",
		`{"message":"{\"code\":\"112\"}"}`: "112",
		`{"body":"{\"code\":\"10605\"}"}`:  "10605",
		`{"code":" 112 "}`:                 "112",
		`{"noCode":true}`:                  "",
		`not json`:                         "",
		`{"code":null}`:                    "",
	}
	for body, want := range cases {
		if got := qoderBodyCode(body); got != want {
			t.Fatalf("qoderBodyCode(%s) = %q, want %q", body, got, want)
		}
	}
}

func TestQoderQuotaGroupsReportsExhaustedCredits(t *testing.T) {
	var payload qoderQuotaUsage
	payload.UserType = "personal_standard"
	payload.UsageType = "credits"
	payload.IsQuotaExceeded = true
	payload.UpgradeURL = "https://qoder.com/pricing?client=qoder"
	payload.UserQuota.Total = 0
	payload.UserQuota.Remaining = 0
	payload.UserQuota.Unit = "credits"

	groups := qoderQuotaGroups(payload)
	if len(groups) != 2 {
		t.Fatalf("groups = %d, want 2 (credits + free model)", len(groups))
	}

	credits := groups[0]
	if !credits.IsExhausted {
		t.Fatal("credits group should be exhausted")
	}
	if credits.RemainingFraction != 0 {
		t.Fatalf("remainingFraction = %v, want 0", credits.RemainingFraction)
	}

	// The account keeps serving the free model, so the dashboard must not imply
	// it is entirely dead.
	free := groups[1]
	if free.IsExhausted {
		t.Fatal("free model group should not be marked exhausted")
	}
	if free.RemainingFraction != 1 {
		t.Fatalf("free model fraction = %v, want 1", free.RemainingFraction)
	}
	if free.DisplayName == "" {
		t.Fatal("free model group needs a display name")
	}
}

func TestQoderQuotaGroupsReportsHealthyCredits(t *testing.T) {
	var payload qoderQuotaUsage
	payload.UserQuota.Total = 100
	payload.UserQuota.Used = 25
	payload.UserQuota.Remaining = 75
	payload.UserQuota.Unit = "credits"

	groups := qoderQuotaGroups(payload)
	if len(groups) != 1 {
		t.Fatalf("groups = %d, want 1 when credits remain", len(groups))
	}
	group := groups[0]
	if group.IsExhausted {
		t.Fatal("group should not be exhausted")
	}
	if group.RemainingFraction != 0.75 {
		t.Fatalf("remainingFraction = %v, want 0.75", group.RemainingFraction)
	}
	if group.PercentUsed != 25 {
		t.Fatalf("percentUsed = %d, want 25", group.PercentUsed)
	}
}

func TestQoderQuotaGroupsPrefersOrgPool(t *testing.T) {
	var payload qoderQuotaUsage
	payload.UserQuota.Total = 0
	payload.OrgResourcePackage = &struct {
		Total     float64 `json:"total"`
		Used      float64 `json:"used"`
		Remaining float64 `json:"remaining"`
		Unit      string  `json:"unit"`
	}{Total: 500, Used: 100, Remaining: 400, Unit: "credits"}

	groups := qoderQuotaGroups(payload)
	if len(groups) != 1 {
		t.Fatalf("groups = %d, want 1", len(groups))
	}
	if groups[0].MaxRequests != 500 {
		t.Fatalf("maxRequests = %v, want 500 from the org pool", groups[0].MaxRequests)
	}
	if groups[0].RemainingFraction != 0.8 {
		t.Fatalf("remainingFraction = %v, want 0.8", groups[0].RemainingFraction)
	}
}
