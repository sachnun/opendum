package proxy

import "testing"

func TestRoamingPointsScaleWithModelCost(t *testing.T) {
	t.Parallel()
	service := &Service{registry: mockRegistry(t)}

	cases := []struct {
		name  string
		model string
		usage *usageCounts
		want  int
	}{
		{"input", mockPricedModel, &usageCounts{inputTokens: 1_000_000}, 10},
		{"output", mockPricedModel, &usageCounts{outputTokens: 1_000_000}, 50},
		{"cache read excludes billable input", mockPricedModel, &usageCounts{inputTokens: 1_000_000, cachedTokens: 1_000_000}, 1},
		{"cache write", mockPricedModel, &usageCounts{cacheWriteTokens: 1_000_000}, 13},
		{"cached tokens above input never negative", mockPricedModel, &usageCounts{inputTokens: 0, cachedTokens: 1_000_000}, 1},
		{"minimum charge", mockPricedModel, &usageCounts{inputTokens: 1}, roamingMinimumPoints},
		{"unknown model uses minimum", "does-not-exist", &usageCounts{inputTokens: 1_000_000}, roamingMinimumPoints},
		{"nil usage uses minimum", mockPricedModel, nil, roamingMinimumPoints},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			if got := service.roamingPoints(tc.model, tc.usage); got != tc.want {
				t.Errorf("roamingPoints = %d, want %d", got, tc.want)
			}
		})
	}
}
