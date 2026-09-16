package proxy

import (
	"math"
	"path/filepath"
	"testing"

	"github.com/opendum/opendum/apps/proxy/internal/models"
)

func TestRoamingPointsScaleWithModelCost(t *testing.T) {
	registry, err := models.Load(filepath.Join("..", "..", "..", "..", "packages", "models", "data"))
	if err != nil {
		t.Fatalf("load registry: %v", err)
	}
	cost := registry.ModelCost("claude-sonnet-5")
	if cost == nil {
		t.Fatal("claude-sonnet-5 has no cost")
	}
	service := &Service{registry: registry}

	cases := []struct {
		name  string
		usage *usageCounts
		want  int
	}{
		{"input", &usageCounts{inputTokens: 1_000_000}, int(math.Ceil(cost.Input))},
		{"output", &usageCounts{outputTokens: 1_000_000}, int(math.Ceil(cost.Output))},
		{"cache read", &usageCounts{inputTokens: 1_000_000, cachedTokens: 1_000_000}, int(math.Ceil(cost.CacheRead))},
		{"cache write", &usageCounts{cacheWriteTokens: 1_000_000}, int(math.Ceil(cost.CacheWrite))},
		{"minimum", &usageCounts{inputTokens: 1}, roamingMinimumPoints},
		{"unknown model", &usageCounts{inputTokens: 1_000_000}, roamingMinimumPoints},
	}
	for _, tc := range cases {
		model := "claude-sonnet-5"
		if tc.name == "unknown model" {
			model = "does-not-exist"
		}
		if got := service.roamingPoints(model, tc.usage); got != tc.want {
			t.Errorf("%s: roamingPoints = %d, want %d", tc.name, got, tc.want)
		}
	}
}
