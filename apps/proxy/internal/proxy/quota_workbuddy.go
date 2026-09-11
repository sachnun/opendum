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
	workbuddyQuotaURL          = "https://www.workbuddy.ai/billing/meter/get-user-resource-summary"
	workbuddyQuotaFreeURL      = "https://www.workbuddy.ai/billing/meter/get-user-resource-free-packages"
	workbuddyQuotaPaidURL      = "https://www.workbuddy.ai/billing/meter/get-user-resource-paid-packages"
	workbuddyQuotaDomain       = "www.workbuddy.ai"
	workbuddyQuotaDetailPagesz = 50
)

type workbuddyQuotaPackage struct {
	PackageCode         string `json:"PackageCode"`
	CycleTotalCapacity  any    `json:"CycleTotalCapacity"`
	CycleRemainCapacity any    `json:"CycleRemainCapacity"`
	CycleUsedCapacity   any    `json:"CycleUsedCapacity"`
}

type workbuddyPackageDetail struct {
	PackageCode    string `json:"PackageCode"`
	PackageName    string `json:"PackageName"`
	CycleStartTime string `json:"CycleStartTime"`
	CycleEndTime   string `json:"CycleEndTime"`
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
	groups := workbuddyQuotaGroups(payload.Data, s.fetchWorkbuddyPackageDetails(ctx, account, headers, forceRefresh, payload.Data.Packages))
	if len(groups) == 0 {
		return errorQuotaInfo(account, "WorkBuddy quota response did not include usable quota data", time.Now().UnixMilli())
	}
	s.putQuotaJSONCache(ctx, result)
	return baseQuotaInfo(account, "success", groups, time.Now().UnixMilli(), "")
}

func workbuddyQuotaGroups(summary workbuddyQuotaSummary, details map[string]workbuddyPackageDetail) []quotaGroupDisplay {
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
		detail := details[name]
		display := workbuddyDisplayName(name, detail.PackageName)
		resetISO, resetHuman := workbuddyResetTimes(detail.CycleEndTime)
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
			ResetTimeIso:      resetISO,
			ResetInHuman:      resetHuman,
			RemainingLabel:    &label,
		})
	}
	return groups
}

func (s *Service) fetchWorkbuddyPackageDetails(ctx context.Context, account appdb.ProviderAccount, headers map[string]string, forceRefresh bool, packages []workbuddyQuotaPackage) map[string]workbuddyPackageDetail {
	out := map[string]workbuddyPackageDetail{}
	codes := []string{}
	seen := map[string]struct{}{}
	for _, pkg := range packages {
		code := strings.TrimSpace(pkg.PackageCode)
		if code == "" {
			continue
		}
		if _, ok := seen[code]; ok {
			continue
		}
		seen[code] = struct{}{}
		codes = append(codes, code)
	}
	if len(codes) == 0 {
		return out
	}
	for _, target := range []struct {
		cache string
		url   string
	}{
		{"workbuddy:resource-free-packages", workbuddyQuotaFreeURL},
		{"workbuddy:resource-paid-packages", workbuddyQuotaPaidURL},
	} {
		body := map[string]any{"PackageCodes": codes, "PageNumber": 1, "PageSize": workbuddyQuotaDetailPagesz}
		result, err := s.getQuotaJSON(ctx, account, forceRefresh, target.cache, http.MethodPost, target.url, headers, body)
		if err != nil || result.Response == nil || result.Response.StatusCode < 200 || result.Response.StatusCode >= 300 {
			continue
		}
		var payload struct {
			Code int    `json:"code"`
			Msg  string `json:"msg"`
			Data struct {
				Accounts []workbuddyPackageDetail `json:"Accounts"`
			} `json:"data"`
		}
		if err := json.Unmarshal(result.Raw, &payload); err != nil || payload.Code != 0 {
			continue
		}
		s.putQuotaJSONCache(ctx, result)
		for _, entry := range payload.Data.Accounts {
			code := strings.TrimSpace(entry.PackageCode)
			if code == "" {
				continue
			}
			if _, ok := out[code]; !ok {
				out[code] = entry
			}
		}
	}
	return out
}

func workbuddyDisplayName(packageCode, packageName string) string {
	if name := strings.TrimSpace(packageName); name != "" {
		if normalized := workbuddyNormalizePackageName(name); normalized != "" {
			return normalized
		}
		return name
	}
	code := strings.TrimSpace(packageCode)
	if strings.HasPrefix(code, "TCACA_code_006") {
		return "Bonus Pack"
	}
	if strings.HasPrefix(code, "TCACA_code_035") {
		return "Free Plan"
	}
	if trimmed := workbuddyStripRandomSuffix(code); trimmed != "" {
		return trimmed
	}
	if code != "" {
		return code
	}
	return "package"
}

func workbuddyNormalizePackageName(name string) string {
	lower := strings.ToLower(strings.TrimSpace(name))
	switch lower {
	case "free plan subscription":
		return "Free Plan"
	case "bonus pack":
		return "Bonus Pack"
	}
	return strings.TrimSpace(name)
}

func workbuddyStripRandomSuffix(code string) string {
	idx := strings.LastIndex(code, "_")
	if idx <= 0 || idx+1 >= len(code) {
		return strings.ReplaceAll(code, "_", " ")
	}
	suffix := code[idx+1:]
	if len(suffix) == 10 && isAlphanumeric(suffix) {
		base := strings.Trim(code[:idx], "_ ")
		if base == "" {
			return ""
		}
		if strings.HasPrefix(base, "TCACA_code_") {
			number := strings.TrimPrefix(base, "TCACA_code_")
			if strings.TrimSpace(number) != "" {
				return "Package " + strings.TrimSpace(number)
			}
		}
		return strings.ReplaceAll(base, "_", " ")
	}
	return strings.ReplaceAll(code, "_", " ")
}

func isAlphanumeric(value string) bool {
	for _, r := range value {
		if (r < '0' || r > '9') && (r < 'A' || r > 'Z') && (r < 'a' || r > 'z') {
			return false
		}
	}
	return len(value) > 0
}

func workbuddyResetTimes(cycleEndTime string) (*string, *string) {
	value := strings.TrimSpace(cycleEndTime)
	if value == "" {
		return nil, nil
	}
	if parsed, ok := workbuddyParseCycleTime(value); ok {
		iso := parsed.UTC().Format(time.RFC3339Nano)
		return &iso, formatTimeUntilResetISO(&iso)
	}
	return nil, nil
}

func workbuddyParseCycleTime(value string) (time.Time, bool) {
	if parsed, err := time.Parse(time.RFC3339Nano, value); err == nil {
		return parsed, true
	}
	if parsed, err := time.Parse(time.RFC3339, value); err == nil {
		return parsed, true
	}
	loc := workbuddyCycleLocation()
	for _, layout := range []string{"2006-01-02 15:04:05", "2006-01-02T15:04:05"} {
		if parsed, err := time.ParseInLocation(layout, value, loc); err == nil {
			return parsed, true
		}
	}
	return time.Time{}, false
}

func workbuddyCycleLocation() *time.Location {
	if loc, err := time.LoadLocation("Asia/Shanghai"); err == nil {
		return loc
	}
	return time.FixedZone("UTC+8", 8*3600)
}
