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
	qoderQuotaUsageURL = "https://openapi.qoder.sh/api/v2/quota/usage"

	// qoderFreeModelUpstream is the one Qoder model observed to keep working on
	// an over-quota account. It is surfaced as a separate quota group so the
	// dashboard shows that the account is not entirely dead.
	qoderFreeModelUpstream = "lite"
)

type qoderQuotaUsage struct {
	UserType             string  `json:"userType"`
	UsageType            string  `json:"usageType"`
	TotalUsagePercentage float64 `json:"totalUsagePercentage"`
	IsQuotaExceeded      bool    `json:"isQuotaExceeded"`
	ExpiresAt            float64 `json:"expiresAt"`
	UpgradeURL           string  `json:"upgradeUrl"`
	UserQuota            struct {
		Total     float64 `json:"total"`
		Used      float64 `json:"used"`
		Remaining float64 `json:"remaining"`
		Unit      string  `json:"unit"`
	} `json:"userQuota"`
	OrgResourcePackage *struct {
		Total     float64 `json:"total"`
		Used      float64 `json:"used"`
		Remaining float64 `json:"remaining"`
		Unit      string  `json:"unit"`
	} `json:"orgResourcePackage"`
}

// fetchQoderQuota reads Qoder's credit balance. Qoder exposes this on
// openapi.qoder.sh and accepts the stored access token directly, so no job-token
// exchange is needed for device-flow accounts.
func (s *Service) fetchQoderQuota(ctx context.Context, account appdb.ProviderAccount, accessToken string, forceRefresh bool) accountQuotaInfo {
	token := strings.TrimSpace(accessToken)
	if token == "" {
		return expiredQuotaInfo(account, "Qoder access token is missing. Re-authenticate this account.")
	}
	result, err := s.getQuotaJSON(ctx, account, forceRefresh, "qoder:quota:usage", http.MethodGet, qoderQuotaUsageURL, map[string]string{
		"Authorization": "Bearer " + token,
		"Accept":        "application/json",
	}, nil)
	if err != nil {
		return errorQuotaInfo(account, err.Error(), time.Now().UnixMilli())
	}
	if result.Response.StatusCode == http.StatusUnauthorized || result.Response.StatusCode == http.StatusForbidden {
		return expiredQuotaInfo(account, "Qoder session is invalid or expired. Re-authenticate this account.")
	}
	if result.Response.StatusCode < 200 || result.Response.StatusCode >= 300 {
		return errorQuotaInfo(account, fmt.Sprintf("Qoder quota endpoint failed: HTTP %d %s", result.Response.StatusCode, string(result.Raw)), time.Now().UnixMilli())
	}

	var payload qoderQuotaUsage
	if err := json.Unmarshal(result.Raw, &payload); err != nil {
		return errorQuotaInfo(account, "Qoder quota response was not valid JSON", time.Now().UnixMilli())
	}
	s.putQuotaJSONCache(ctx, result)

	groups := qoderQuotaGroups(payload)
	if len(groups) == 0 {
		return errorQuotaInfo(account, "Qoder quota response contained no usage data", time.Now().UnixMilli())
	}
	return baseQuotaInfo(account, "success", groups, time.Now().UnixMilli(), "")
}

// qoderQuotaGroups maps Qoder's credit balance into display groups.
//
// Qoder reports a single credit pool that gates its frontier models. When that
// pool is empty the account still serves `lite`, so the exhausted state is
// reported per pool rather than as a dead account, and the remaining free model
// is listed separately.
func qoderQuotaGroups(payload qoderQuotaUsage) []quotaGroupDisplay {
	groups := []quotaGroupDisplay{}

	quota := payload.UserQuota
	if org := payload.OrgResourcePackage; org != nil && org.Total > 0 {
		quota = struct {
			Total     float64 `json:"total"`
			Used      float64 `json:"used"`
			Remaining float64 `json:"remaining"`
			Unit      string  `json:"unit"`
		}{Total: org.Total, Used: org.Used, Remaining: org.Remaining, Unit: org.Unit}
	}

	unit := strings.TrimSpace(quota.Unit)
	if unit == "" {
		unit = "credits"
	}
	limit := math.Max(0, quota.Total)
	used := math.Max(0, quota.Used)
	remaining := math.Max(0, quota.Remaining)
	if limit > 0 {
		used = math.Min(used, limit)
		remaining = math.Min(remaining, limit)
	}

	// Prefer the explicit exhaustion flag: Qoder has been observed to report a
	// zeroed quota with `isQuotaExceeded: true` and no usage percentage.
	exhausted := payload.IsQuotaExceeded || (limit > 0 && remaining <= 0)

	fraction := 1.0
	switch {
	case exhausted:
		fraction = 0
	case limit > 0:
		fraction = clampFraction(remaining / limit)
	}
	remainingLabel := fmt.Sprintf("%s / %s %s", formatFloat(remaining), formatFloat(limit), unit)
	if limit == 0 {
		remainingLabel = fmt.Sprintf("%s %s", formatFloat(remaining), unit)
	}

	name := "credits"
	displayName := "Credits"
	if payload.IsQuotaExceeded {
		displayName = "Credits (exhausted)"
	}
	groups = append(groups, quotaGroupDisplay{
		Name:              name,
		DisplayName:       displayName,
		RemainingFraction: fraction,
		RemainingRequests: displayNumber(remaining),
		MaxRequests:       displayNumber(limit),
		UsedRequests:      displayNumber(used),
		PercentUsed:       int(math.Round(clampFraction(1-fraction) * 100)),
		IsExhausted:       exhausted,
		Confidence:        "high",
		RemainingLabel:    &remainingLabel,
	})

	// Qoder keeps serving `lite` after the credit pool is empty, so report it
	// separately instead of letting the exhausted pool imply the account is dead.
	if payload.IsQuotaExceeded {
		freeLabel := "available"
		groups = append(groups, quotaGroupDisplay{
			Name:              "free-model",
			DisplayName:       "Free model (" + qoderFreeModelUpstream + ")",
			RemainingFraction: 1,
			IsExhausted:       false,
			Confidence:        "medium",
			RemainingLabel:    &freeLabel,
		})
	}

	if resetAt := qoderResetTime(payload.ExpiresAt); resetAt != nil {
		for i := range groups {
			groups[i].ResetTimeIso = resetAt
		}
	}
	if upgrade := strings.TrimSpace(payload.UpgradeURL); upgrade != "" && payload.IsQuotaExceeded {
		for i := range groups {
			if groups[i].Name == name {
				reason := "Out of credits. Upgrade at " + upgrade
				groups[i].RemainingLabel = &reason
			}
		}
	}
	return groups
}

// qoderResetTime converts Qoder's millisecond expiry into an ISO timestamp.
// The value is far in the future for perpetual allowances, so it is treated as
// informational rather than as a real reset.
func qoderResetTime(expiresAt float64) *string {
	if expiresAt <= 0 {
		return nil
	}
	seconds := int64(expiresAt)
	if expiresAt > 1e12 {
		seconds = int64(expiresAt / 1000)
	}
	value := time.Unix(seconds, 0).UTC().Format(time.RFC3339)
	return &value
}
