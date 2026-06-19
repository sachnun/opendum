package proxy

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/opendum/opendum/apps/proxy/internal/cryptojs"
	appdb "github.com/opendum/opendum/apps/proxy/internal/db"
)

const copilotDefaultMonthlyLimit = 300.0

var antigravityQuotaMaxRequests = map[string]map[string]float64{
	"standard-tier": {"claude-opus-4-6": 150, "claude-sonnet-4-6": 150, "gemini-3.1-pro-preview": 320, "gemini-3.5-flash": 400, "gpt-oss-120b": 100},
	"free-tier":     {"claude-opus-4-6": 50, "claude-sonnet-4-6": 50, "gemini-3.1-pro-preview": 150, "gemini-3.5-flash": 500, "gpt-oss-120b": 100},
	"legacy-tier":   {"claude-opus-4-6": 50, "claude-sonnet-4-6": 50, "gemini-3.1-pro-preview": 150, "gemini-3.5-flash": 500, "gpt-oss-120b": 100},
}

func (s *Service) fetchOpenRouterQuota(ctx context.Context, account appdb.ProviderAccount, forceRefresh bool) accountQuotaInfo {
	apiKey, err := cryptojs.Decrypt(s.secret, account.AccessToken)
	if err != nil {
		return expiredQuotaInfo(account, "API key is missing or invalid. Please reconnect this account.")
	}
	keyData, keyErr := s.fetchOpenRouterData(ctx, account, apiKey, "/key", forceRefresh)
	creditsData, creditsErr := s.fetchOpenRouterData(ctx, account, apiKey, "/credits", forceRefresh)
	if keyErr != nil && creditsErr != nil {
		return errorQuotaInfo(account, keyErr.Error(), time.Now().UnixMilli())
	}
	return baseQuotaInfo(account, "success", openRouterGroups(keyData, creditsData), time.Now().UnixMilli(), "")
}

func (s *Service) fetchOpenRouterData(ctx context.Context, account appdb.ProviderAccount, apiKey, path string, forceRefresh bool) (map[string]any, error) {
	result, err := s.getQuotaJSON(ctx, account, forceRefresh, "openrouter:"+strings.TrimPrefix(path, "/"), http.MethodGet, "https://openrouter.ai/api/v1"+path, map[string]string{"Authorization": "Bearer " + strings.TrimSpace(apiKey), "Accept": "application/json"}, nil)
	if err != nil {
		return nil, err
	}
	if result.Response.StatusCode < 200 || result.Response.StatusCode >= 300 {
		return nil, fmt.Errorf("Openrouter%s request failed: HTTP %d %s", path, result.Response.StatusCode, string(result.Raw))
	}
	var payload map[string]any
	if err := json.Unmarshal(result.Raw, &payload); err != nil {
		return nil, err
	}
	data := parseQuotaRecord(payload["data"])
	if data == nil {
		return nil, fmt.Errorf("Openrouter%s response did not include a data object", path)
	}
	s.putQuotaJSONCache(ctx, result)
	return data, nil
}

func openRouterGroups(keyData, creditsData map[string]any) []quotaGroupDisplay {
	groups := []quotaGroupDisplay{}
	totalCredits, hasTotal := parseQuotaNumber(creditsData["total_credits"])
	totalUsage, hasUsage := parseQuotaNumber(creditsData["total_usage"])
	if hasTotal && hasUsage && totalCredits > 0 {
		remaining := math.Max(0, totalCredits-totalUsage)
		fraction := clampFraction(remaining / totalCredits)
		label := fmt.Sprintf("$%.2f / $%.2f", remaining, totalCredits)
		groups = append(groups, quotaGroupDisplay{Name: "account-credits", DisplayName: "Account credits", Models: []string{}, RemainingFraction: fraction, RemainingRequests: displayNumber(remaining), MaxRequests: displayNumber(totalCredits), UsedRequests: displayNumber(totalCredits - remaining), PercentUsed: int(math.Round(clampFraction((totalCredits-remaining)/totalCredits) * 100)), IsExhausted: fraction <= 0, IsEstimated: false, Confidence: "high", RemainingLabel: &label})
	}
	limit, hasLimit := parseQuotaNumber(keyData["limit"])
	remaining, hasRemaining := parseQuotaNumber(keyData["limit_remaining"])
	_, hasKeyUsage := parseQuotaNumber(keyData["usage"])
	if hasLimit && hasRemaining && hasKeyUsage && limit > 0 {
		fraction := clampFraction(remaining / limit)
		label := fmt.Sprintf("$%.2f / $%.2f", remaining, limit)
		groups = append(groups, quotaGroupDisplay{Name: "key-limit", DisplayName: "API key limit", Models: []string{}, RemainingFraction: fraction, RemainingRequests: displayNumber(remaining), MaxRequests: displayNumber(limit), UsedRequests: displayNumber(math.Max(0, limit-remaining)), PercentUsed: int(math.Round(clampFraction((limit-remaining)/limit) * 100)), IsExhausted: fraction <= 0, IsEstimated: false, Confidence: "high", RemainingLabel: &label})
	}
	if len(groups) > 0 {
		return groups
	}
	if usageDaily, ok := parseQuotaNumber(keyData["usage_daily"]); ok {
		label := fmt.Sprintf("$%.2f", usageDaily)
		return []quotaGroupDisplay{{Name: "daily-usage", DisplayName: "Today usage", Models: []string{}, RemainingFraction: 1, RemainingRequests: 1, MaxRequests: 1, UsedRequests: 0, PercentUsed: 0, IsExhausted: false, IsEstimated: true, Confidence: "medium", ResetInHuman: stringPtr("resets daily"), RemainingLabel: &label}}
	}
	label := "active"
	if value, ok := keyData["is_free_tier"].(bool); ok && value {
		label = "free tier"
	}
	return []quotaGroupDisplay{{Name: "key-status", DisplayName: "Openrouter key", Models: []string{}, RemainingFraction: 1, RemainingRequests: 1, MaxRequests: 1, UsedRequests: 0, PercentUsed: 0, IsExhausted: false, IsEstimated: true, Confidence: "low", RemainingLabel: &label}}
}

func (s *Service) fetchSiliconFlowQuota(ctx context.Context, account appdb.ProviderAccount, forceRefresh bool) accountQuotaInfo {
	apiKey, err := cryptojs.Decrypt(s.secret, account.AccessToken)
	if err != nil {
		return expiredQuotaInfo(account, "API key is missing or invalid. Please reconnect this account.")
	}
	result, err := s.getQuotaJSON(ctx, account, forceRefresh, "siliconflow:user-info", http.MethodGet, "https://api.siliconflow.com/v1/user/info", map[string]string{"Authorization": "Bearer " + strings.TrimSpace(apiKey), "Accept": "application/json"}, nil)
	if err != nil {
		return errorQuotaInfo(account, err.Error(), time.Now().UnixMilli())
	}
	if result.Response.StatusCode < 200 || result.Response.StatusCode >= 300 {
		return errorQuotaInfo(account, fmt.Sprintf("SiliconFlow user info endpoint failed: HTTP %d %s", result.Response.StatusCode, string(result.Raw)), time.Now().UnixMilli())
	}
	var payload map[string]any
	if err := json.Unmarshal(result.Raw, &payload); err != nil {
		return errorQuotaInfo(account, "SiliconFlow user info response was not valid JSON", time.Now().UnixMilli())
	}
	data := parseQuotaRecord(payload["data"])
	if data == nil {
		return errorQuotaInfo(account, "SiliconFlow user info response did not include a data object", time.Now().UnixMilli())
	}
	s.putQuotaJSONCache(ctx, result)
	return baseQuotaInfo(account, "success", siliconFlowGroups(data), time.Now().UnixMilli(), "")
}

func siliconFlowGroups(data map[string]any) []quotaGroupDisplay {
	total, hasTotal := parseQuotaNumber(data["totalBalance"])
	if !hasTotal {
		total, hasTotal = parseQuotaNumber(data["balance"])
	}
	if !hasTotal {
		label := "active"
		return []quotaGroupDisplay{{Name: "account-balance", DisplayName: "Account balance", Models: []string{}, RemainingFraction: 1, RemainingRequests: 1, MaxRequests: 1, UsedRequests: 0, PercentUsed: 0, IsExhausted: false, IsEstimated: true, Confidence: "low", RemainingLabel: &label}}
	}
	label := fmt.Sprintf("$%.2f", total)
	return []quotaGroupDisplay{{Name: "account-balance", DisplayName: "Account balance", Models: []string{}, RemainingFraction: 1, RemainingRequests: 1, MaxRequests: 1, UsedRequests: 0, PercentUsed: 0, IsExhausted: total <= 0, IsEstimated: true, Confidence: "medium", RemainingLabel: &label}}
}

func (s *Service) fetchAntigravityQuota(ctx context.Context, account appdb.ProviderAccount, accessToken string, forceRefresh bool) accountQuotaInfo {
	tier := quotaFallbackTier(account)
	projectID := ""
	if account.ProjectID != nil {
		projectID = strings.TrimSpace(*account.ProjectID)
	}
	if projectID == "" {
		return errorQuotaInfo(account, "Antigravity account is missing projectId. Re-authenticate this account.", time.Now().UnixMilli())
	}
	endpoints := []string{"https://cloudcode-pa.googleapis.com", "https://daily-cloudcode-pa.googleapis.com"}
	var lastErr string
	for _, endpoint := range endpoints {
		result, err := s.getQuotaJSON(ctx, account, forceRefresh, "antigravity:fetchAvailableModels", http.MethodPost, endpoint+"/v1internal:fetchAvailableModels", map[string]string{"Authorization": "Bearer " + accessToken, "Content-Type": "application/json", "User-Agent": "antigravity/1.23.2 linux/amd64"}, map[string]any{"project": projectID})
		if err != nil {
			lastErr = err.Error()
			continue
		}
		if result.Response.StatusCode < 200 || result.Response.StatusCode >= 300 {
			lastErr = fmt.Sprintf("HTTP %d %s", result.Response.StatusCode, string(result.Raw))
			continue
		}
		var payload map[string]any
		if err := json.Unmarshal(result.Raw, &payload); err != nil {
			lastErr = err.Error()
			continue
		}
		s.putQuotaJSONCache(ctx, result)
		return baseQuotaInfo(account, "success", antigravityGroups(payload, tier), time.Now().UnixMilli(), "")
	}
	return errorQuotaInfo(account, "Failed to fetch Antigravity quota data: "+lastErr, time.Now().UnixMilli())
}

func antigravityGroups(payload map[string]any, tier string) []quotaGroupDisplay {
	models := parseQuotaRecord(payload["models"])
	apiNames := map[string]string{"claude-opus-4-6": "claude-opus-4-6-thinking", "gemini-2.5-flash": "gemini-2.5-flash-thinking", "gemini-3.1-pro-preview": "gemini-3.1-pro-high", "gemini-3.5-flash": "gemini-3.5-flash-medium", "gpt-oss-120b": "gpt-oss-120b-medium"}
	configs := []struct {
		name    string
		display string
		models  []string
	}{
		{name: "claude", display: "Claude", models: []string{"claude-opus-4-6", "claude-sonnet-4-6", "gpt-oss-120b"}},
		{name: "gemini", display: "Gemini", models: []string{"gemini-3.1-pro-preview", "gemini-3.5-flash", "gemini-2.5-flash", "gemini-2.5-flash-lite"}},
	}
	groups := []quotaGroupDisplay{}
	for _, cfg := range configs {
		remainingFraction := 1.0
		var resetISO *string
		for _, model := range cfg.models {
			apiModel := apiNames[model]
			if apiModel == "" {
				apiModel = model
			}
			modelRecord := parseQuotaRecord(models[apiModel])
			quotaInfo := parseQuotaRecord(modelRecord["quotaInfo"])
			if quotaInfo == nil {
				continue
			}
			if quotaInfo["remainingFraction"] == nil {
				remainingFraction = 0
			} else if value, ok := parseQuotaNumber(quotaInfo["remainingFraction"]); ok {
				remainingFraction = clampFraction(value)
			}
			if iso := parseResetISO(quotaInfo["resetTime"]); iso != nil {
				resetISO = iso
			}
			break
		}
		maxRequests := antigravityMaxRequests(cfg.models[0], tier)
		remaining := math.Max(0, math.Floor(remainingFraction*maxRequests))
		percentUsed := int(math.Round(clampFraction((maxRequests-remaining)/maxRequests) * 100))
		groups = append(groups, quotaGroupDisplay{Name: cfg.name, DisplayName: cfg.display, Models: cfg.models, RemainingFraction: remainingFraction, RemainingRequests: remaining, MaxRequests: maxRequests, UsedRequests: maxRequests - remaining, PercentUsed: percentUsed, IsExhausted: remainingFraction <= 0, IsEstimated: true, Confidence: "medium", ResetTimeIso: resetISO, ResetInHuman: formatTimeUntilResetISO(resetISO), RemainingLabel: stringPtr(fmt.Sprintf("%d%%", int(math.Round(remainingFraction*100))))})
	}
	return groups
}

func antigravityMaxRequests(model, tier string) float64 {
	if tierMap := antigravityQuotaMaxRequests[normalizeAntigravityQuotaTier(tier)]; tierMap != nil {
		if value := tierMap[model]; value > 0 {
			return value
		}
	}
	if tierMap := antigravityQuotaMaxRequests["free-tier"]; tierMap != nil {
		if value := tierMap[model]; value > 0 {
			return value
		}
	}
	return 100
}

func normalizeAntigravityQuotaTier(tier string) string {
	switch strings.ToLower(strings.TrimSpace(tier)) {
	case "standard-tier", "paid":
		return "standard-tier"
	case "legacy-tier":
		return "legacy-tier"
	case "free-tier", "free":
		return "free-tier"
	default:
		return strings.ToLower(strings.TrimSpace(tier))
	}
}

func parseResetISO(value any) *string {
	switch typed := value.(type) {
	case string:
		if parsed, err := time.Parse(time.RFC3339Nano, typed); err == nil {
			iso := parsed.UTC().Format(time.RFC3339Nano)
			return &iso
		}
	case float64:
		ms := int64(typed * 1000)
		if typed > 10000000000 {
			ms = int64(typed)
		}
		iso := time.UnixMilli(ms).UTC().Format(time.RFC3339Nano)
		return &iso
	case map[string]any:
		if seconds, ok := parseQuotaNumber(typed["seconds"]); ok {
			iso := time.UnixMilli(int64(seconds * 1000)).UTC().Format(time.RFC3339Nano)
			return &iso
		}
	}
	return nil
}

func (s *Service) fetchCopilotQuota(ctx context.Context, account appdb.ProviderAccount, accessToken string, forceRefresh bool) accountQuotaInfo {
	result, err := s.getQuotaJSON(ctx, account, forceRefresh, "copilot:user", http.MethodGet, "https://api.github.com/copilot_internal/user", map[string]string{"Authorization": "Bearer " + accessToken, "Accept": "application/json", "User-Agent": "GitHubCopilotChat/0.26.7", "Editor-Version": "vscode/1.96.2", "Editor-Plugin-Version": "copilot-chat/0.26.7"}, nil)
	if err != nil {
		return errorQuotaInfo(account, err.Error(), time.Now().UnixMilli())
	}
	if result.Response.StatusCode < 200 || result.Response.StatusCode >= 300 {
		return errorQuotaInfo(account, fmt.Sprintf("Copilot internal quota endpoint failed: HTTP %d %s", result.Response.StatusCode, string(result.Raw)), time.Now().UnixMilli())
	}
	var payload map[string]any
	if err := json.Unmarshal(result.Raw, &payload); err != nil {
		return errorQuotaInfo(account, "Copilot quota response was not valid JSON", time.Now().UnixMilli())
	}
	plan := strings.ToLower(strings.ReplaceAll(parseQuotaString(payload["copilot_plan"]), "_", "-"))
	if detected := normalizeCopilotTier(payload); detected != "" {
		plan = detected
	}
	entitlement, remaining := copilotEntitlement(payload, plan)
	used := math.Max(0, entitlement-remaining)
	fraction := 1.0
	if entitlement > 0 {
		fraction = clampFraction(remaining / entitlement)
	}
	resetISO := copilotResetISO(payload)
	label := fmt.Sprintf("%s/%s used", formatFloat(used), formatFloat(entitlement))
	group := quotaGroupDisplay{Name: "premium_requests", DisplayName: "Premium requests", Models: []string{}, RemainingFraction: fraction, RemainingRequests: displayNumber(remaining), MaxRequests: displayNumber(entitlement), UsedRequests: displayNumber(used), PercentUsed: int(math.Round(clampFraction(used/entitlement) * 100)), IsExhausted: fraction <= 0, IsEstimated: false, Confidence: "medium", ResetTimeIso: resetISO, ResetInHuman: formatTimeUntilResetISO(resetISO), RemainingLabel: &label}
	s.putQuotaJSONCache(ctx, result)
	return baseQuotaInfo(account, "success", []quotaGroupDisplay{group}, time.Now().UnixMilli(), "")
}

func copilotEntitlement(payload map[string]any, plan string) (float64, float64) {
	planLimits := map[string]float64{"free": 50, "student": 300, "pro": 300, "pro+": 1500, "business": 300, "enterprise": 1000}
	entitlement := planLimits[plan]
	remaining := entitlement
	snapshots := payload["quota_snapshots"]
	for _, raw := range parseSnapshotValues(snapshots) {
		record := parseQuotaRecord(raw)
		if record == nil {
			continue
		}
		if record["quota_id"] != nil && parseQuotaString(record["quota_id"]) != "premium_interactions" {
			continue
		}
		if value, ok := parseQuotaNumber(record["entitlement"]); ok && value > 0 {
			entitlement = value
		}
		if value, ok := parseQuotaNumber(record["quota_remaining"]); ok {
			remaining = value
		} else if value, ok := parseQuotaNumber(record["remaining"]); ok {
			remaining = value
		}
		break
	}
	if entitlement <= 0 {
		entitlement = copilotDefaultMonthlyLimit
		remaining = entitlement
	}
	return entitlement, math.Max(0, remaining)
}

func normalizeCopilotTier(payload map[string]any) string {
	for _, raw := range []string{parseQuotaString(payload["access_type_sku"]), parseQuotaString(payload["copilot_plan"])} {
		value := strings.ToLower(strings.ReplaceAll(strings.TrimSpace(raw), "_", "-"))
		if value == "" {
			continue
		}
		if strings.Contains(value, "education") || strings.Contains(value, "student") {
			return "student"
		}
		if strings.Contains(value, "free") {
			return "free"
		}
		if strings.Contains(value, "enterprise") {
			return "enterprise"
		}
		if strings.Contains(value, "business") {
			return "business"
		}
		if value == "pro-plus" || value == "proplus" || value == "pro+" {
			return "pro+"
		}
		if value == "pro" || strings.Contains(value, "-pro-") {
			return "pro"
		}
	}

	return ""
}

func parseSnapshotValues(value any) []any {
	if array := parseQuotaArray(value); array != nil {
		return array
	}
	if record := parseQuotaRecord(value); record != nil {
		out := []any{}
		for _, item := range record {
			out = append(out, item)
		}
		return out
	}
	return nil
}

func copilotResetISO(payload map[string]any) *string {
	for _, key := range []string{"quota_reset_date_utc", "quota_reset_date"} {
		value := parseQuotaString(payload[key])
		if value == "" {
			continue
		}
		if parsed, err := time.Parse("2006-01-02", value); err == nil {
			iso := parsed.UTC().Format(time.RFC3339Nano)
			return &iso
		}
		if parsed, err := time.Parse(time.RFC3339Nano, value); err == nil {
			iso := parsed.UTC().Format(time.RFC3339Nano)
			return &iso
		}
	}
	return nil
}

func formatFloat(value float64) string {
	if math.Abs(value-math.Round(value)) < 0.001 {
		return fmt.Sprintf("%.0f", value)
	}
	return fmt.Sprintf("%.2f", value)
}

func (s *Service) fetchCodexQuota(ctx context.Context, account appdb.ProviderAccount, accessToken string, forceRefresh bool) accountQuotaInfo {
	fallbackTier := quotaFallbackTier(account)
	headers := map[string]string{"Authorization": "Bearer " + accessToken, "Accept": "application/json", "User-Agent": "opencode/1.14.28 (linux linux; amd64)", "Origin": "https://chatgpt.com", "Referer": "https://chatgpt.com/", "originator": "opencode"}
	if accountID := accountIDForQuotaCodex(account, accessToken); accountID != "" {
		headers["ChatGPT-Account-Id"] = accountID
	}
	result, err := s.getQuotaJSON(ctx, account, forceRefresh, "codex:usage", http.MethodGet, "https://chatgpt.com/backend-api/wham/usage", headers, nil)
	if err != nil {
		return errorQuotaInfo(account, err.Error(), time.Now().UnixMilli())
	}
	headerData := parseCodexQuotaHeaderGroups(result.Response.Header, fallbackTier)
	if result.Response.StatusCode < 200 || result.Response.StatusCode >= 300 {
		if len(headerData) > 0 {
			return baseQuotaInfo(account, "success", headerData, time.Now().UnixMilli(), "")
		}
		return errorQuotaInfo(account, fmt.Sprintf("Codex quota endpoint failed: HTTP %d %s", result.Response.StatusCode, string(result.Raw)), time.Now().UnixMilli())
	}
	var payload map[string]any
	_ = json.Unmarshal(result.Raw, &payload)
	tier := parseQuotaString(payload["plan_type"])
	if tier == "" {
		tier = fallbackTier
	}
	apiGroups := parseCodexAPIGroups(payload, tier)
	if len(apiGroups) > 0 {
		s.putQuotaJSONCache(ctx, result)
		return baseQuotaInfo(account, "success", apiGroups, time.Now().UnixMilli(), "")
	}
	if len(headerData) > 0 {
		s.putQuotaJSONCache(ctx, result)
		return baseQuotaInfo(account, "success", headerData, time.Now().UnixMilli(), "")
	}
	return errorQuotaInfo(account, "Codex quota payload did not include usable quota data", time.Now().UnixMilli())
}

func accountIDForQuotaCodex(account appdb.ProviderAccount, accessToken string) string {
	if account.AccountID != nil && strings.TrimSpace(*account.AccountID) != "" {
		return strings.TrimSpace(*account.AccountID)
	}
	return extractQuotaAccountIDFromJWT(accessToken)
}

func extractQuotaAccountIDFromJWT(token string) string {
	parts := strings.Split(token, ".")
	if len(parts) < 2 || strings.TrimSpace(parts[1]) == "" {
		return ""
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return ""
	}
	var claims map[string]any
	if err := json.Unmarshal(payload, &claims); err != nil {
		return ""
	}
	if authClaims := parseQuotaRecord(claims["https://api.openai.com/auth"]); authClaims != nil {
		for _, key := range []string{"chatgpt_workspace_id", "workspace_id", "organization_id"} {
			if value := parseQuotaString(authClaims[key]); value != "" {
				return value
			}
		}
	}
	for _, key := range []string{"chatgpt_workspace_id", "workspace_id", "organization_id"} {
		if value := parseQuotaString(claims[key]); value != "" {
			return value
		}
	}
	return ""
}

func parseCodexAPIGroups(payload map[string]any, tier string) []quotaGroupDisplay {
	rateLimit := parseQuotaRecord(payload["rate_limit"])
	return codexWindowGroups(parseQuotaRecord(rateLimit["primary_window"]), parseQuotaRecord(rateLimit["secondary_window"]), tier, true)
}

func parseCodexQuotaHeaderGroups(headers http.Header, tier string) []quotaGroupDisplay {
	primary := map[string]any{"used_percent": headers.Get("x-codex-primary-used-percent"), "limit_window_minutes": headers.Get("x-codex-primary-window-minutes"), "reset_at": headers.Get("x-codex-primary-reset-at")}
	secondary := map[string]any{"used_percent": headers.Get("x-codex-secondary-used-percent"), "limit_window_minutes": headers.Get("x-codex-secondary-window-minutes"), "reset_at": headers.Get("x-codex-secondary-reset-at")}
	return codexWindowGroups(primary, secondary, tier, false)
}

func codexWindowGroups(primary, secondary map[string]any, tier string, apiNames bool) []quotaGroupDisplay {
	groups := []quotaGroupDisplay{}
	if group, ok := codexWindowGroup("primary", primary, tier, apiNames); ok {
		groups = append(groups, group)
	}
	if group, ok := codexWindowGroup("secondary", secondary, tier, apiNames); ok {
		groups = append(groups, group)
	}
	return groups
}

func codexWindowGroup(name string, record map[string]any, tier string, apiNames bool) (quotaGroupDisplay, bool) {
	used, ok := parseQuotaNumber(record["used_percent"])
	if !ok {
		return quotaGroupDisplay{}, false
	}
	windowMinutes, _ := parseQuotaNumber(record["window_minutes"])
	if !apiNames {
		windowMinutes, _ = parseQuotaNumber(record["limit_window_minutes"])
	} else if windowMinutes == 0 {
		seconds, _ := parseQuotaNumber(record["limit_window_seconds"])
		windowMinutes = math.Ceil(seconds / 60)
	}
	resetAt, _ := parseQuotaNumber(record["reset_at"])
	resetTimestamp := int64(0)
	if resetAt > 10000000000 {
		resetTimestamp = int64(resetAt)
	} else if resetAt > 0 {
		resetTimestamp = int64(resetAt * 1000)
	}
	remainingPercent := math.Max(0, 100-used)
	display := "Usage"
	if name == "secondary" {
		display = "Weekly usage"
	} else if windowMinutes > 0 {
		display = codexWindowDisplayName(windowMinutes)
	}

	return quotaGroupDisplay{Name: name, DisplayName: display, Models: []string{}, RemainingFraction: remainingPercent / 100, RemainingRequests: math.Round(remainingPercent), MaxRequests: 100, UsedRequests: 100 - math.Round(remainingPercent), PercentUsed: int(math.Round(used)), IsExhausted: used >= 100, IsEstimated: false, Confidence: "high", ResetTimeIso: resetISOFromMillis(resetTimestamp), ResetInHuman: formatTimeUntilReset(resetTimestamp)}, true
}

func codexWindowDisplayName(windowMinutes float64) string {
	roundedMinutes := int(math.Round(windowMinutes))
	if roundedMinutes == 300 {
		return "5 hour usage"
	}
	if roundedMinutes > 0 && roundedMinutes%1440 == 0 {
		return fmt.Sprintf("%dd usage", roundedMinutes/1440)
	}
	if roundedMinutes > 0 && roundedMinutes%60 == 0 {
		return fmt.Sprintf("%d hour usage", roundedMinutes/60)
	}
	return fmt.Sprintf("%.0fm usage", windowMinutes)
}

func resetISOFromMillis(ms int64) *string {
	if ms <= 0 {
		return nil
	}
	iso := time.UnixMilli(ms).UTC().Format(time.RFC3339Nano)
	return &iso
}

func (s *Service) fetchKiroQuota(ctx context.Context, account appdb.ProviderAccount, accessToken string, forceRefresh bool) accountQuotaInfo {
	values := url.Values{}
	values.Set("origin", "AI_EDITOR")
	if account.AccountID != nil && strings.TrimSpace(*account.AccountID) != "" {
		values.Set("profileArn", strings.TrimSpace(*account.AccountID))
	}
	target := encodeQuery("https://q.us-east-1.amazonaws.com/", values)
	body := map[string]any{"origin": "AI_EDITOR"}
	if profile := values.Get("profileArn"); profile != "" {
		body["profileArn"] = profile
	}
	result, err := s.getQuotaJSON(ctx, account, forceRefresh, "kiro:GetUsageLimits", http.MethodPost, target, map[string]string{"Authorization": "Bearer " + accessToken, "Content-Type": "application/x-amz-json-1.0", "Accept": "application/json", "User-Agent": "KiroIDE-0.7.45", "x-amz-user-agent": "KiroIDE-0.7.45", "x-amz-target": "AmazonCodeWhispererService.GetUsageLimits", "x-amzn-codewhisperer-optout": "true", "x-amzn-kiro-agent-mode": "vibe", "amz-sdk-request": "attempt=1; max=3"}, body)
	if err != nil {
		return errorQuotaInfo(account, err.Error(), time.Now().UnixMilli())
	}
	if result.Response.StatusCode < 200 || result.Response.StatusCode >= 300 {
		return errorQuotaInfo(account, fmt.Sprintf("Kiro usage limits quota endpoint failed: HTTP %d %s", result.Response.StatusCode, string(result.Raw)), time.Now().UnixMilli())
	}
	var payload map[string]any
	if err := json.Unmarshal(result.Raw, &payload); err != nil {
		return errorQuotaInfo(account, "Kiro usage limits response was not valid JSON", time.Now().UnixMilli())
	}
	record := parseQuotaRecord(payload["data"])
	if record == nil {
		record = payload
	}
	tier := kiroTier(record)
	if tier == "" {
		tier = quotaFallbackTier(account)
	}
	groups := kiroGroups(record)
	if len(groups) == 0 {
		return errorQuotaInfo(account, "Kiro usage limits are unavailable for this account", time.Now().UnixMilli())
	}
	s.putQuotaJSONCache(ctx, result)
	return baseQuotaInfo(account, "success", groups, time.Now().UnixMilli(), "")
}

func kiroTier(record map[string]any) string {
	sub := parseQuotaRecord(record["subscriptionInfo"])
	return normalizeKiroSubscriptionTier(parseQuotaString(sub["type"]), parseQuotaString(sub["subscriptionTitle"]))
}

func normalizeKiroSubscriptionTier(rawType, subscriptionTitle string) string {
	switch strings.ToUpper(strings.TrimSpace(rawType)) {
	case "Q_DEVELOPER_STANDALONE_FREE":
		return "free"
	case "Q_DEVELOPER_STANDALONE_POWER":
		return "power"
	case "Q_DEVELOPER_STANDALONE_PRO":
		return "pro"
	case "Q_DEVELOPER_STANDALONE_PRO_PLUS":
		return "pro-plus"
	case "Q_DEVELOPER_STANDALONE":
		return "standalone"
	}

	title := strings.ToLower(strings.TrimSpace(subscriptionTitle))
	if title == "" {
		return ""
	}
	if strings.Contains(title, "pro+") || strings.Contains(title, "pro plus") {
		return "pro-plus"
	}
	if strings.Contains(title, "power") {
		return "power"
	}
	if strings.Contains(title, "pro") {
		return "pro"
	}
	if strings.Contains(title, "free") {
		return "free"
	}
	title = strings.NewReplacer("_", " ", "-", " ").Replace(title)
	return strings.Join(strings.Fields(title), "-")
}

func kiroGroups(record map[string]any) []quotaGroupDisplay {
	labels := map[string]string{"AI_EDITOR": "Kiro requests", "AGENTIC_REQUEST": "Agentic requests", "CODE_COMPLETIONS": "Code completions", "TRANSFORM": "Transform", "CREDIT": "Credits", "VIBE": "Vibe usage", "SPEC": "Spec usage"}
	metrics := []map[string]any{}
	for _, raw := range parseQuotaArray(record["limits"]) {
		if metric := parseQuotaRecord(raw); metric != nil {
			metrics = append(metrics, metric)
		}
	}
	for _, raw := range parseQuotaArray(record["usageBreakdownList"]) {
		if metric := parseQuotaRecord(raw); metric != nil {
			metrics = append(metrics, metric)
		}
	}
	groups := []quotaGroupDisplay{}
	for _, metric := range metrics {
		name := strings.ToUpper(firstNonEmpty(parseQuotaString(metric["type"]), parseQuotaString(metric["resourceType"]), parseQuotaString(metric["displayName"])))
		if name == "" {
			continue
		}
		current, okCurrent := firstNumber(metric["currentUsage"], metric["currentUsageWithPrecision"])
		limit, okLimit := firstNumber(metric["totalUsageLimit"], metric["usageLimitWithPrecision"], metric["usageLimit"])
		if !okCurrent || !okLimit || limit <= 0 {
			continue
		}
		remaining := math.Max(0, limit-current)
		fraction := clampFraction(remaining / limit)
		percentUsed := int(math.Round(clampFraction(current/limit) * 100))
		resetISO := parseResetISO(firstNonNil(metric["nextDateReset"], record["nextDateReset"]))
		display := labels[name]
		if display == "" {
			display = strings.Title(strings.ToLower(strings.ReplaceAll(name, "_", " ")))
		}
		groups = append(groups, quotaGroupDisplay{Name: strings.ToLower(name), DisplayName: display, Models: []string{}, RemainingFraction: fraction, RemainingRequests: displayNumber(remaining), MaxRequests: displayNumber(limit), UsedRequests: displayNumber(current), PercentUsed: percentUsed, IsExhausted: fraction <= 0, IsEstimated: false, Confidence: "high", ResetTimeIso: resetISO, ResetInHuman: formatTimeUntilResetISO(resetISO)})
	}
	return groups
}

func firstNumber(values ...any) (float64, bool) {
	for _, value := range values {
		if parsed, ok := parseQuotaNumber(value); ok {
			return parsed, true
		}
	}
	return 0, false
}
func firstNonNil(values ...any) any {
	for _, value := range values {
		if value != nil {
			return value
		}
	}
	return nil
}
func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}
