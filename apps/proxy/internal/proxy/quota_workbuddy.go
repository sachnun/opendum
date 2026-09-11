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
	workbuddyQuotaURL    = "https://www.workbuddy.ai/billing/meter/get-user-resource-summary"
	workbuddyQuotaDomain = "www.workbuddy.ai"
)

type workbuddyQuotaPackage struct {
	PackageCode         string `json:"PackageCode"`
	CycleTotalCapacity  any    `json:"CycleTotalCapacity"`
	CycleRemainCapacity any    `json:"CycleRemainCapacity"`
	CycleUsedCapacity   any    `json:"CycleUsedCapacity"`
}

type workbuddyQuotaSummary struct {
	Packages   []workbuddyQuotaPackage `json:"Packages"`
	IsPaidUser bool                    `json:"IsPaidUser"`
}

func (s *Service) fetchWorkbuddyQuota(ctx context.Context, account appdb.ProviderAccount, accessToken string, forceRefresh bool) accountQuotaInfo {
	token := strings.TrimSpace(accessToken)
	if token == "" {
		return expiredQuotaInfo(account, "WorkBuddy access token is missing. Re-authenticate this account.")
	}
	headers := map[string]string{
		"Authorization": "Bearer " + token,
		"Content-Type":  "application/json",
		"Accept":        "application/json",
		"X-Domain":      workbuddyQuotaDomain,
	}
	if account.AccountID != nil && strings.TrimSpace(*account.AccountID) != "" {
		headers["X-User-Id"] = strings.TrimSpace(*account.AccountID)
	}
	result, err := s.getQuotaJSON(ctx, account, forceRefresh, "workbuddy:resource-summary", http.MethodPost, workbuddyQuotaURL, headers, map[string]any{})
	if err != nil {
		return errorQuotaInfo(account, err.Error(), time.Now().UnixMilli())
	}
	if result.Response.StatusCode == http.StatusUnauthorized || result.Response.StatusCode == http.StatusForbidden {
		return expiredQuotaInfo(account, "WorkBuddy session is invalid or expired. Re-authenticate this account.")
	}
	if result.Response.StatusCode < 200 || result.Response.StatusCode >= 300 {
		return errorQuotaInfo(account, fmt.Sprintf("WorkBuddy quota endpoint failed: HTTP %d %s", result.Response.StatusCode, string(result.Raw)), time.Now().UnixMilli())
	}
	var payload struct {
		Code int                   `json:"code"`
		Msg  string                `json:"msg"`
		Data workbuddyQuotaSummary `json:"data"`
	}
	if err := json.Unmarshal(result.Raw, &payload); err != nil {
		return errorQuotaInfo(account, "WorkBuddy quota response was not valid JSON", time.Now().UnixMilli())
	}
	if payload.Code != 0 {
		return errorQuotaInfo(account, fmt.Sprintf("WorkBuddy quota request failed: %d %s", payload.Code, payload.Msg), time.Now().UnixMilli())
	}
	groups := workbuddyQuotaGroups(payload.Data)
	if len(groups) == 0 {
		return errorQuotaInfo(account, "WorkBuddy quota response did not include usable quota data", time.Now().UnixMilli())
	}
	s.putQuotaJSONCache(ctx, result)
	return baseQuotaInfo(account, "success", groups, time.Now().UnixMilli(), "")
}

func workbuddyQuotaGroups(summary workbuddyQuotaSummary) []quotaGroupDisplay {
	groups := []quotaGroupDisplay{}
	for _, pkg := range summary.Packages {
		total, okTotal := parseQuotaNumber(pkg.CycleTotalCapacity)
		remaining, okRemaining := parseQuotaNumber(pkg.CycleRemainCapacity)
		used, _ := parseQuotaNumber(pkg.CycleUsedCapacity)
		if !okTotal || !okRemaining || total <= 0 {
			continue
		}
		used = math.Min(math.Max(0, used), total)
		remaining = math.Max(0, math.Min(remaining, total))
		fraction := clampFraction(remaining / total)
		name := strings.TrimSpace(pkg.PackageCode)
		if name == "" {
			name = "package"
		}
		display := name
		if idx := strings.LastIndex(name, "_"); idx >= 0 && idx+1 < len(name) {
			display = name[idx+1:]
		}
		label := fmt.Sprintf("%s / %s credits", formatFloat(remaining), formatFloat(total))
		groups = append(groups, quotaGroupDisplay{
			Name:              name,
			DisplayName:       display,
			Models:            []string{},
			RemainingFraction: fraction,
			RemainingRequests: displayNumber(remaining),
			MaxRequests:       displayNumber(total),
			UsedRequests:      displayNumber(used),
			PercentUsed:       int(math.Round(clampFraction(used/total) * 100)),
			IsExhausted:       fraction <= 0,
			IsEstimated:       false,
			Confidence:        "high",
			RemainingLabel:    &label,
		})
	}
	return groups
}
