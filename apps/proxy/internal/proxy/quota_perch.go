package proxy

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"strings"
	"time"

	appdb "github.com/opendum/opendum/apps/proxy/internal/db"
)

const (
	perchAccountURL        = "https://app.perchai.app/api/perchai/account"
	perchMonthlyPTFallback = 20000.0
	perchPTPerUSD          = 1000.0
)

type perchAccountEntitlement struct {
	Key       string `json:"key"`
	ValueJSON struct {
		Limit *float64 `json:"limit"`
	} `json:"value_json"`
}

type perchRollingWindow struct {
	Enabled             bool     `json:"enabled"`
	Window5hUsd         *float64 `json:"window5hUsd"`
	Window5hCapUsd      *float64 `json:"window5hCapUsd"`
	Window5hNextFreedAt *string  `json:"window5hNextFreedAt"`
	Window7dUsd         *float64 `json:"window7dUsd"`
	Window7dCapUsd      *float64 `json:"window7dCapUsd"`
	Window7dNextFreedAt *string  `json:"window7dNextFreedAt"`
}

type perchUsageMeter struct {
	DailyPt      *float64            `json:"dailyPt"`
	WeeklyPt     *float64            `json:"weeklyPt"`
	MonthlyPt    *float64            `json:"monthlyPt"`
	DailyUsd     *float64            `json:"dailyUsd"`
	WeeklyUsd    *float64            `json:"weeklyUsd"`
	MonthlyUsd   *float64            `json:"monthlyUsd"`
	RoostRolling *perchRollingWindow `json:"roostRolling"`
}

type perchAccountSession struct {
	PlanCode              string                    `json:"planCode"`
	PlanName              string                    `json:"planName"`
	TierSelectionRequired bool                      `json:"tierSelectionRequired"`
	Entitlements          []perchAccountEntitlement `json:"entitlements"`
}

type perchAccountResponse struct {
	OK              bool                `json:"ok"`
	Session         perchAccountSession `json:"session"`
	UsageMeter      perchUsageMeter     `json:"usageMeter"`
	CreditBalancePt *float64            `json:"creditBalancePt"`
}

func (s *Service) fetchPerchQuota(ctx context.Context, account appdb.ProviderAccount, accessToken string, forceRefresh bool) accountQuotaInfo {
	token := strings.TrimSpace(accessToken)
	if token == "" {
		return expiredQuotaInfo(account, "Perch access token is missing. Re-authenticate this account.")
	}
	result, err := s.getQuotaJSON(ctx, account, forceRefresh, "perch:account", http.MethodGet, perchAccountURL, map[string]string{"Authorization": "Bearer " + token, "Accept": "application/json"}, nil)
	if err != nil {
		return errorQuotaInfo(account, err.Error(), time.Now().UnixMilli())
	}
	if result.Response.StatusCode == http.StatusUnauthorized || result.Response.StatusCode == http.StatusForbidden {
		return expiredQuotaInfo(account, "Perch session is invalid or expired. Re-authenticate this account.")
	}
	if result.Response.StatusCode < 200 || result.Response.StatusCode >= 300 {
		return errorQuotaInfo(account, fmt.Sprintf("Perch account quota endpoint failed: HTTP %d %s", result.Response.StatusCode, string(result.Raw)), time.Now().UnixMilli())
	}
	var payload perchAccountResponse
	if err := json.Unmarshal(result.Raw, &payload); err != nil {
		return errorQuotaInfo(account, "Perch account response was not valid JSON", time.Now().UnixMilli())
	}
	if !payload.OK {
		return errorQuotaInfo(account, "Perch account request was rejected. Re-authenticate this account.", time.Now().UnixMilli())
	}
	if payload.Session.TierSelectionRequired {
		return expiredQuotaInfo(account, "Perch account has no active plan yet. Re-authenticate to select the Starter plan.")
	}
	groups := perchQuotaGroups(payload)
	if len(groups) == 0 {
		return errorQuotaInfo(account, "Perch account has no usage or allowance data", time.Now().UnixMilli())
	}
	s.putQuotaJSONCache(ctx, result)
	return baseQuotaInfo(account, "success", groups, time.Now().UnixMilli(), "")
}

// perchMonthlyPTLimit resolves the monthly allowance from the
// usage.monthly_pt entitlement, falling back to the Starter/Pilot default
// (20k PT) exactly like the Perch CLI /usage panel.
func perchMonthlyPTLimit(payload perchAccountResponse) float64 {
	for _, entitlement := range payload.Session.Entitlements {
		if entitlement.Key != "usage.monthly_pt" || entitlement.ValueJSON.Limit == nil {
			continue
		}
		if limit := *entitlement.ValueJSON.Limit; limit > 0 {
			return limit
		}
	}
	return perchMonthlyPTFallback
}

func perchPT(usd *float64) float64 {
	if usd == nil {
		return 0
	}
	return math.Max(0, *usd*perchPTPerUSD)
}

func perchQuotaGroups(payload perchAccountResponse) []quotaGroupDisplay {
	groups := []quotaGroupDisplay{}
	meter := payload.UsageMeter

	limit := perchMonthlyPTLimit(payload)
	monthlyUsed := math.Max(0, perchPtrValue(meter.MonthlyPt))
	if meter.MonthlyPt == nil {
		monthlyUsed = math.Max(0, perchPT(meter.MonthlyUsd))
	}
	used := math.Min(monthlyUsed, limit)
	remaining := math.Max(0, limit-used)
	fraction := clampFraction(remaining / limit)
	remainingLabel := fmt.Sprintf("%s / %s PT", formatFloat(remaining), formatFloat(limit))
	groups = append(groups, quotaGroupDisplay{
		Name:              "monthly-allowance",
		DisplayName:       "Monthly allowance",
		RemainingFraction: fraction,
		RemainingRequests: displayNumber(remaining),
		MaxRequests:       displayNumber(limit),
		UsedRequests:      displayNumber(used),
		PercentUsed:       int(math.Round(clampFraction(used/limit) * 100)),
		IsExhausted:       fraction <= 0,
		IsEstimated:       meter.MonthlyPt == nil && meter.MonthlyUsd != nil,
		Confidence:        "medium",
		RemainingLabel:    &remainingLabel,
	})

	if rolling := meter.RoostRolling; rolling != nil && rolling.Enabled {
		if capUSD := rolling.Window7dCapUsd; capUSD != nil && *capUSD > 0 {
			groups = append(groups, perchWindowGroup("fair-use-7d", "7-day fair use", rolling.Window7dUsd, *capUSD, rolling.Window7dNextFreedAt))
		}
		if capUSD := rolling.Window5hCapUsd; capUSD != nil && *capUSD > 0 {
			groups = append(groups, perchWindowGroup("fair-use-5h", "5-hour fair use", rolling.Window5hUsd, *capUSD, rolling.Window5hNextFreedAt))
		}
	}

	if credits := payload.CreditBalancePt; credits != nil && *credits > 0 {
		balance := math.Floor(*credits)
		label := fmt.Sprintf("%s PT available", formatFloat(balance))
		groups = append(groups, quotaGroupDisplay{
			Name:              "credits",
			DisplayName:       "Credits",
			RemainingFraction: 1,
			RemainingRequests: displayNumber(balance),
			MaxRequests:       displayNumber(balance),
			UsedRequests:      0,
			PercentUsed:       0,
			IsExhausted:       false,
			IsEstimated:       true,
			Confidence:        "low",
			RemainingLabel:    &label,
		})
	}

	return groups
}

func perchWindowGroup(name, display string, usedUSD *float64, capUSD float64, nextFreedAt *string) quotaGroupDisplay {
	used := math.Max(0, perchPtrValue(usedUSD))
	capValue := math.Max(0, capUSD)
	remaining := math.Max(0, capValue-used)
	fraction := clampFraction(remaining / capValue)
	label := fmt.Sprintf("$%s / $%s", formatFloat(remaining), formatFloat(capValue))
	var resetISO *string
	if nextFreedAt != nil && strings.TrimSpace(*nextFreedAt) != "" {
		iso := strings.TrimSpace(*nextFreedAt)
		if parsed, err := time.Parse(time.RFC3339Nano, iso); err == nil {
			normalized := parsed.UTC().Format(time.RFC3339Nano)
			resetISO = &normalized
		}
	}
	return quotaGroupDisplay{
		Name:              name,
		DisplayName:       display,
		RemainingFraction: fraction,
		RemainingRequests: displayNumber(remaining),
		MaxRequests:       displayNumber(capValue),
		UsedRequests:      displayNumber(used),
		PercentUsed:       int(math.Round(clampFraction(used/capValue) * 100)),
		IsExhausted:       fraction <= 0,
		IsEstimated:       false,
		Confidence:        "medium",
		ResetTimeIso:      resetISO,
		ResetInHuman:      formatTimeUntilResetISO(resetISO),
		RemainingLabel:    &label,
	}
}

func perchPtrValue(usd *float64) float64 {
	if usd == nil {
		return 0
	}
	return *usd
}
