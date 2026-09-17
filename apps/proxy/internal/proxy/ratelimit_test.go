package proxy

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/opendum/opendum/apps/proxy/internal/auth"
)

func intPtr(value int) *int { return &value }

func TestToInt(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name string
		in   any
		want int
	}{
		{"int", int(7), 7},
		{"int64", int64(8), 8},
		{"uint64", uint64(9), 9},
		{"numeric string", "10", 10},
		{"invalid string", "abc", 0},
		{"nil", nil, 0},
		{"unsupported type", 1.5, 0},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			if got := toInt(tc.in); got != tc.want {
				t.Fatalf("toInt(%v) = %d, want %d", tc.in, got, tc.want)
			}
		})
	}
}

func TestMaxInt(t *testing.T) {
	t.Parallel()
	if got := maxInt(3, 5); got != 5 {
		t.Fatalf("maxInt(3,5) = %d, want 5", got)
	}
	if got := maxInt(9, 2); got != 9 {
		t.Fatalf("maxInt(9,2) = %d, want 9", got)
	}
}

func TestWindowBucketAlignsToWindow(t *testing.T) {
	t.Parallel()
	for _, window := range []int{60, 3600, 86400} {
		bucket := windowBucket(window)
		now := time.Now().Unix()
		if bucket%int64(window) != 0 {
			t.Fatalf("windowBucket(%d) = %d, not aligned", window, bucket)
		}
		if bucket > now || now-bucket >= int64(window) {
			t.Fatalf("windowBucket(%d) = %d out of current window", window, bucket)
		}
	}
}

func TestApiKeyWindowKeyFormat(t *testing.T) {
	t.Parallel()
	key := apiKeyWindowKey("key_1", mockFamilyModel, "min", 60)
	if !strings.HasPrefix(key, apiKeyRateLimitPrefix+":key_1:"+mockFamilyModel+":min:") {
		t.Fatalf("key = %q, missing expected prefix", key)
	}
	parts := strings.Split(key, ":")
	if bucket := parts[len(parts)-1]; bucket == "" {
		t.Fatalf("key = %q, missing window bucket", key)
	}
}

func TestMatchRateLimitRulePrefersModelRule(t *testing.T) {
	t.Parallel()
	service := &Service{registry: mockRegistry(t)}
	rules := []auth.RateLimitRule{
		{Target: mockFamilyModel, TargetType: "model", PerMinute: intPtr(5)},
		{Target: "mock-family", TargetType: "family", PerMinute: intPtr(1)},
	}

	rule, ok := service.matchRateLimitRule(mockFamilyModel, "", rules)
	if !ok {
		t.Fatal("matchRateLimitRule returned no match for exact model rule")
	}
	if rule.Target != mockFamilyModel || rule.TargetType != "model" {
		t.Fatalf("matched rule = %+v, want model rule %s", rule, mockFamilyModel)
	}
}

func TestMatchRateLimitRuleFallsBackToFamily(t *testing.T) {
	t.Parallel()
	service := &Service{registry: mockRegistry(t)}
	rules := []auth.RateLimitRule{{Target: "mock-family", TargetType: "family", PerHour: intPtr(100)}}

	rule, ok := service.matchRateLimitRule(mockFamilyModel, "", rules)
	if !ok {
		t.Fatal("matchRateLimitRule did not match family rule for model in that family")
	}
	if rule.TargetType != "family" || rule.Target != "mock-family" {
		t.Fatalf("matched rule = %+v, want family rule mock-family", rule)
	}
}

func TestMatchRateLimitRuleNoFalseMatch(t *testing.T) {
	t.Parallel()
	service := &Service{registry: mockRegistry(t)}
	rules := []auth.RateLimitRule{{Target: mockFamilyModel, TargetType: "model", PerMinute: intPtr(5)}}
	if _, ok := service.matchRateLimitRule(mockPlainModel, "", rules); ok {
		t.Fatal("matchRateLimitRule matched an unrelated model")
	}
	if _, ok := service.matchRateLimitRule(mockFamilyModel, "", nil); ok {
		t.Fatal("matchRateLimitRule matched with no rules")
	}
}

func TestMatchRateLimitRuleUsesAlias(t *testing.T) {
	t.Parallel()
	service := &Service{registry: mockRegistry(t)}
	rules := []auth.RateLimitRule{{Target: mockFamilyModel, TargetType: "model", PerMinute: intPtr(5)}}

	rule, ok := service.matchRateLimitRule("custom-slug/"+mockFamilyModel, mockFamilyModel, rules)
	if !ok {
		t.Fatal("matchRateLimitRule did not match via alias")
	}
	if rule.Target != mockFamilyModel {
		t.Fatalf("matched rule = %+v, want %s", rule, mockFamilyModel)
	}
}

func TestCheckAndIncrementAPIKeyRateLimitWithoutMatchingRule(t *testing.T) {
	t.Parallel()
	service := &Service{registry: mockRegistry(t)}
	ctx := context.Background()

	result, err := service.checkAndIncrementAPIKeyRateLimit(ctx, "key_1", mockPlainModel, "", []auth.RateLimitRule{
		{Target: mockFamilyModel, TargetType: "model", PerMinute: intPtr(1)},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !result.Allowed {
		t.Fatal("request with no matching rule should be allowed")
	}

	result, err = service.checkAndIncrementAPIKeyRateLimit(ctx, "key_1", "anything", "", nil)
	if err != nil || !result.Allowed {
		t.Fatalf("empty rules result = %+v, err = %v, want allowed", result, err)
	}
}
