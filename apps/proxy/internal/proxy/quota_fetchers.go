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
	"standard-tier": {"claude-opus-4-6": 150, "claude-sonnet-4-6": 150, "gemini-3.1-pro-preview": 320},
	"free-tier":     {"claude-opus-4-6": 50, "claude-sonnet-4-6": 50, "gemini-3.1-pro-preview": 150},
	"legacy-tier":   {"claude-opus-4-6": 50, "claude-sonnet-4-6": 50, "gemini-3.1-pro-preview": 150},
}

func (s *Service) fetchOpenRouterQuota(ctx context.Context, account appdb.ProviderAccount) accountQuotaInfo {
	apiKey, err := cryptojs.Decrypt(s.secret, account.AccessToken)
	if err != nil {
		return expiredQuotaInfo(account, "unknown", "API key is missing or invalid. Please reconnect this account.")
	}
	keyData, keyErr := s.fetchOpenRouterData(ctx, apiKey, "/key")
	creditsData, creditsErr := s.fetchOpenRouterData(ctx, apiKey, "/credits")
	if keyErr != nil && creditsErr != nil {
		return errorQuotaInfo(account, "unknown", keyErr.Error(), time.Now().UnixMilli())
	}
	tier := "paid"
	if value, ok := keyData["is_free_tier"].(bool); ok && value {
		tier = "free"
	}
	return baseQuotaInfo(account, tier, "success", openRouterGroups(keyData, creditsData), time.Now().UnixMilli(), "")
}

func (s *Service) fetchOpenRouterData(ctx context.Context, apiKey, path string) (map[string]any, error) {
	resp, raw, err := getJSON(ctx, s.client, http.MethodGet, "https://openrouter.ai/api/v1"+path, map[string]string{"Authorization": "Bearer " + strings.TrimSpace(apiKey), "Accept": "application/json"}, nil)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("OpenRouter%s request failed: HTTP %d %s", path, resp.StatusCode, string(raw))
	}
	var payload map[string]any
	if err := json.Unmarshal(raw, &payload); err != nil {
		return nil, err
	}
	data := parseQuotaRecord(payload["data"])
	if data == nil {
		return nil, fmt.Errorf("OpenRouter%s response did not include a data object", path)
	}
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
	return []quotaGroupDisplay{{Name: "key-status", DisplayName: "OpenRouter key", Models: []string{}, RemainingFraction: 1, RemainingRequests: 1, MaxRequests: 1, UsedRequests: 0, PercentUsed: 0, IsExhausted: false, IsEstimated: true, Confidence: "low", RemainingLabel: &label}}
}

func (s *Service) fetchAntigravityQuota(ctx context.Context, account appdb.ProviderAccount, accessToken string) accountQuotaInfo {
	tier := quotaFallbackTier(account)
	projectID := ""
	if account.ProjectID != nil {
		projectID = strings.TrimSpace(*account.ProjectID)
	}
	if projectID == "" {
		return errorQuotaInfo(account, tier, "Antigravity account is missing projectId. Re-authenticate this account.", time.Now().UnixMilli())
	}
	endpoints := []string{"https://cloudcode-pa.googleapis.com", "https://daily-cloudcode-pa.googleapis.com"}
	var lastErr string
	for _, endpoint := range endpoints {
		resp, raw, err := getJSON(ctx, s.client, http.MethodPost, endpoint+"/v1internal:fetchAvailableModels", map[string]string{"Authorization": "Bearer " + accessToken, "Content-Type": "application/json", "User-Agent": "antigravity/1.23.2 linux/amd64"}, map[string]any{"project": projectID})
		if err != nil {
			lastErr = err.Error()
			continue
		}
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			lastErr = fmt.Sprintf("HTTP %d %s", resp.StatusCode, string(raw))
			continue
		}
		var payload map[string]any
		if err := json.Unmarshal(raw, &payload); err != nil {
			lastErr = err.Error()
			continue
		}
		return baseQuotaInfo(account, tier, "success", antigravityGroups(payload, tier), time.Now().UnixMilli(), "")
	}
	return errorQuotaInfo(account, tier, "Failed to fetch Antigravity quota data: "+lastErr, time.Now().UnixMilli())
}

func antigravityGroups(payload map[string]any, tier string) []quotaGroupDisplay {
	models := parseQuotaRecord(payload["models"])
	configs := map[string][]string{"claude": {"claude-opus-4-6", "claude-sonnet-4-6"}, "g3-pro": {"gemini-3.1-pro-preview"}}
	display := map[string]string{"claude": "Claude", "g3-pro": "Gemini 3.1 Pro"}
	apiNames := map[string]string{"claude-opus-4-6": "claude-opus-4-6-thinking", "gemini-3.1-pro-preview": "gemini-3.1-pro-high"}
	groups := []quotaGroupDisplay{}
	for name, modelList := range configs {
		remainingFraction := 1.0
		var resetISO *string
		for _, model := range modelList {
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
		maxRequests := antigravityMaxRequests(modelList[0], tier)
		remaining := math.Max(0, math.Floor(remainingFraction*maxRequests))
		percentUsed := int(math.Round(clampFraction((maxRequests-remaining)/maxRequests) * 100))
		groups = append(groups, quotaGroupDisplay{Name: name, DisplayName: display[name], Models: modelList, RemainingFraction: remainingFraction, RemainingRequests: remaining, MaxRequests: maxRequests, UsedRequests: maxRequests - remaining, PercentUsed: percentUsed, IsExhausted: remainingFraction <= 0, IsEstimated: true, Confidence: "medium", ResetTimeIso: resetISO, ResetInHuman: formatTimeUntilResetISO(resetISO), RemainingLabel: stringPtr(fmt.Sprintf("%d%%", int(math.Round(remainingFraction*100))))})
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

func (s *Service) fetchCopilotQuota(ctx context.Context, account appdb.ProviderAccount, accessToken string) accountQuotaInfo {
	tier := strings.TrimSpace(quotaFallbackTier(account))
	resp, raw, err := getJSON(ctx, s.client, http.MethodGet, "https://api.github.com/copilot_internal/user", map[string]string{"Authorization": "Bearer " + accessToken, "Accept": "application/json", "User-Agent": "GitHubCopilotChat/0.26.7", "Editor-Version": "vscode/1.96.2", "Editor-Plugin-Version": "copilot-chat/0.26.7"}, nil)
	if err != nil {
		return errorQuotaInfo(account, tier, err.Error(), time.Now().UnixMilli())
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return errorQuotaInfo(account, tier, fmt.Sprintf("Copilot internal quota endpoint failed: HTTP %d %s", resp.StatusCode, string(raw)), time.Now().UnixMilli())
	}
	var payload map[string]any
	if err := json.Unmarshal(raw, &payload); err != nil {
		return errorQuotaInfo(account, tier, "Copilot quota response was not valid JSON", time.Now().UnixMilli())
	}
	plan := strings.ToLower(parseQuotaString(payload["copilot_plan"]))
	if plan != "" {
		tier = plan
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
	return baseQuotaInfo(account, tier, "success", []quotaGroupDisplay{group}, time.Now().UnixMilli(), "")
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

func (s *Service) fetchCodexQuota(ctx context.Context, account appdb.ProviderAccount, accessToken string) accountQuotaInfo {
	fallbackTier := quotaFallbackTier(account)
	headers := map[string]string{"Authorization": "Bearer " + accessToken, "Accept": "application/json", "User-Agent": "opencode/1.14.28 (linux linux; amd64)", "Origin": "https://chatgpt.com", "Referer": "https://chatgpt.com/", "originator": "opencode"}
	if accountID := accountIDForQuotaCodex(account, accessToken); accountID != "" {
		headers["ChatGPT-Account-Id"] = accountID
	}
	resp, raw, err := getJSON(ctx, s.client, http.MethodGet, "https://chatgpt.com/backend-api/wham/usage", headers, nil)
	if err != nil {
		return errorQuotaInfo(account, fallbackTier, err.Error(), time.Now().UnixMilli())
	}
	headerData := parseCodexQuotaHeaderGroups(resp.Header, fallbackTier)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		if len(headerData) > 0 {
			return baseQuotaInfo(account, fallbackTier, "success", headerData, time.Now().UnixMilli(), "")
		}
		return errorQuotaInfo(account, fallbackTier, fmt.Sprintf("Codex quota endpoint failed: HTTP %d %s", resp.StatusCode, string(raw)), time.Now().UnixMilli())
	}
	var payload map[string]any
	_ = json.Unmarshal(raw, &payload)
	tier := parseQuotaString(payload["plan_type"])
	if tier == "" {
		tier = fallbackTier
	}
	if tier != fallbackTier && account.ID != "" {
		_, _ = s.db.NewUpdate().Model((*appdb.ProviderAccount)(nil)).Set("tier = ?", tier).Where("id = ?", account.ID).Exec(ctx)
	}
	apiGroups := parseCodexAPIGroups(payload, tier)
	if len(apiGroups) > 0 {
		return baseQuotaInfo(account, tier, "success", apiGroups, time.Now().UnixMilli(), "")
	}
	if len(headerData) > 0 {
		return baseQuotaInfo(account, tier, "success", headerData, time.Now().UnixMilli(), "")
	}
	return errorQuotaInfo(account, tier, "Codex quota payload did not include usable quota data", time.Now().UnixMilli())
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
		display = fmt.Sprintf("%.0fm usage", windowMinutes)
		if windowMinutes == 300 {
			display = "5 hour usage"
		}
	}
	if strings.Contains(strings.ToLower(tier), "free") && (name == "secondary" || windowMinutes == 10080) {
		display = "Weekly usage (free)"
	}
	return quotaGroupDisplay{Name: name, DisplayName: display, Models: []string{}, RemainingFraction: remainingPercent / 100, RemainingRequests: math.Round(remainingPercent), MaxRequests: 100, UsedRequests: 100 - math.Round(remainingPercent), PercentUsed: int(math.Round(used)), IsExhausted: used >= 100, IsEstimated: false, Confidence: "high", ResetTimeIso: resetISOFromMillis(resetTimestamp), ResetInHuman: formatTimeUntilReset(resetTimestamp)}, true
}

func resetISOFromMillis(ms int64) *string {
	if ms <= 0 {
		return nil
	}
	iso := time.UnixMilli(ms).UTC().Format(time.RFC3339Nano)
	return &iso
}

func (s *Service) fetchGeminiCLIQuota(ctx context.Context, account appdb.ProviderAccount, accessToken string) accountQuotaInfo {
	tier := quotaFallbackTier(account)
	if tier == "free" {
		tier = "free-tier"
	}
	projectID := ""
	if account.ProjectID != nil {
		projectID = strings.TrimSpace(*account.ProjectID)
	}
	if projectID == "" {
		info := s.discoverGeminiCLIAccount(ctx, account, accessToken)
		projectID = info.projectID
		if info.tier != "" {
			tier = info.tier
		}
		if projectID != "" {
			_, _ = s.db.NewUpdate().Model((*appdb.ProviderAccount)(nil)).Set("\"projectId\" = ?", projectID).Set("tier = ?", tier).Where("id = ?", account.ID).Exec(ctx)
		}
	}
	if projectID == "" {
		return errorQuotaInfo(account, tier, "Gemini CLI account is missing projectId. Re-authenticate this account.", time.Now().UnixMilli())
	}
	for _, endpoint := range []string{"https://daily-cloudcode-pa.sandbox.googleapis.com", "https://cloudcode-pa.googleapis.com"} {
		resp, raw, err := getJSON(ctx, s.client, http.MethodPost, endpoint+"/v1internal:retrieveUserQuota", map[string]string{"Authorization": "Bearer " + accessToken, "Content-Type": "application/json", "Accept": "application/json", "User-Agent": "GeminiCLI/0.34.0 (win32; x64)"}, map[string]any{"project": projectID})
		if err != nil || resp.StatusCode < 200 || resp.StatusCode >= 300 {
			continue
		}
		var payload map[string]any
		if err := json.Unmarshal(raw, &payload); err != nil {
			continue
		}
		groups := geminiQuotaGroups(payload, tier)
		if len(groups) > 0 {
			return baseQuotaInfo(account, tier, "success", groups, time.Now().UnixMilli(), "")
		}
	}
	return errorQuotaInfo(account, tier, "Failed to fetch Gemini CLI quota data", time.Now().UnixMilli())
}

type geminiCLIInfo struct{ projectID, tier string }

func (s *Service) discoverGeminiCLIAccount(ctx context.Context, account appdb.ProviderAccount, accessToken string) geminiCLIInfo {
	for _, endpoint := range []string{"https://cloudcode-pa.googleapis.com", "https://daily-cloudcode-pa.sandbox.googleapis.com"} {
		resp, raw, err := getJSON(ctx, s.client, http.MethodPost, endpoint+"/v1internal:loadCodeAssist", map[string]string{"Authorization": "Bearer " + accessToken, "Content-Type": "application/json", "User-Agent": "GeminiCLI/0.34.0 (win32; x64)"}, map[string]any{"cloudaicompanionProject": nil, "metadata": map[string]string{"ideType": "IDE_UNSPECIFIED", "platform": "PLATFORM_UNSPECIFIED", "pluginType": "GEMINI"}})
		if err != nil || resp.StatusCode < 200 || resp.StatusCode >= 300 {
			continue
		}
		var payload map[string]any
		if err := json.Unmarshal(raw, &payload); err != nil {
			continue
		}
		projectID := googleProjectID(payload)
		tier := googleCurrentTier(payload)
		if projectID != "" {
			return geminiCLIInfo{projectID: projectID, tier: tier}
		}
	}
	return geminiCLIInfo{}
}

func googleProjectID(payload map[string]any) string {
	if value := parseQuotaString(payload["cloudaicompanionProject"]); value != "" {
		return value
	}
	if record := parseQuotaRecord(payload["cloudaicompanionProject"]); record != nil {
		return parseQuotaString(record["id"])
	}
	return ""
}

func googleCurrentTier(payload map[string]any) string {
	if value := parseQuotaString(payload["currentTier"]); value != "" {
		return value
	}
	if record := parseQuotaRecord(payload["currentTier"]); record != nil {
		if value := parseQuotaString(record["id"]); value != "" {
			return value
		}
		return parseQuotaString(record["name"])
	}
	return ""
}

func geminiQuotaGroups(payload map[string]any, tier string) []quotaGroupDisplay {
	buckets := parseQuotaArray(payload["buckets"])
	models := map[string]quotaGroupDisplay{}
	for _, raw := range buckets {
		bucket := parseQuotaRecord(raw)
		modelID := normalizeGeminiModelID(parseQuotaString(bucket["modelId"])); if modelID == "" { continue }
		fraction, ok := parseQuotaNumber(bucket["remainingFraction"]); if !ok { continue }
		fraction = clampFraction(fraction)
		maxRequests := 100.0
		remaining := math.Round(fraction * maxRequests)
		if amount := parseQuotaString(bucket["remainingAmount"]); amount != "" {
			if parsed, err := strconvParseFloat(amount); err == nil && fraction > 0 { remaining = parsed; maxRequests = math.Round(parsed / fraction) }
		}
		resetISO := parseResetISO(bucket["resetTime"])
		models[modelID] = quotaGroupDisplay{Name: modelID, Models: []string{modelID}, RemainingFraction: fraction, RemainingRequests: remaining, MaxRequests: maxRequests, UsedRequests: math.Max(0, maxRequests-remaining), PercentUsed: int(math.Round(clampFraction((maxRequests-remaining)/maxRequests)*100)), IsExhausted: fraction <= 0, IsEstimated: false, Confidence: "high", ResetTimeIso: resetISO, ResetInHuman: formatTimeUntilResetISO(resetISO)}
	}
	configs := map[string]struct{ display string; models []string }{"pro": {"Gemini Pro", []string{"gemini-2.5-pro", "gemini-3.1-pro-preview"}}, "25-flash": {"Gemini 2.5 Flash", []string{"gemini-2.5-flash", "gemini-2.5-flash-lite"}}, "3-flash": {"Gemini 3 Flash", []string{"gemini-3-flash-preview", "gemini-3.1-flash-lite"}}}
	groups := []quotaGroupDisplay{}
	for name, cfg := range configs {
		for _, model := range cfg.models {
			if group, ok := models[model]; ok { group.Name = name; group.DisplayName = cfg.display; group.Models = cfg.models; groups = append(groups, group); break }
		}
	}
	return groups
}

func normalizeGeminiModelID(model string) string {
	model = lastPathSegment(model)
	if model == "gemini-3.1-flash-lite-preview" { return "gemini-3.1-flash-lite" }
	return model
}

func (s *Service) fetchKiroQuota(ctx context.Context, account appdb.ProviderAccount, accessToken string) accountQuotaInfo {
	fallbackTier := quotaFallbackTier(account)
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
	resp, raw, err := getJSON(ctx, s.client, http.MethodPost, target, map[string]string{"Authorization": "Bearer " + accessToken, "Content-Type": "application/x-amz-json-1.0", "Accept": "application/json", "User-Agent": "KiroIDE-0.7.45", "x-amz-user-agent": "KiroIDE-0.7.45", "x-amz-target": "AmazonCodeWhispererService.GetUsageLimits", "x-amzn-codewhisperer-optout": "true", "x-amzn-kiro-agent-mode": "vibe", "amz-sdk-request": "attempt=1; max=3"}, body)
	if err != nil {
		return errorQuotaInfo(account, fallbackTier, err.Error(), time.Now().UnixMilli())
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return errorQuotaInfo(account, fallbackTier, fmt.Sprintf("Kiro usage limits quota endpoint failed: HTTP %d %s", resp.StatusCode, string(raw)), time.Now().UnixMilli())
	}
	var payload map[string]any
	if err := json.Unmarshal(raw, &payload); err != nil {
		return errorQuotaInfo(account, fallbackTier, "Kiro usage limits response was not valid JSON", time.Now().UnixMilli())
	}
	record := parseQuotaRecord(payload["data"])
	if record == nil {
		record = payload
	}
	tier := kiroTier(record)
	if tier == "" {
		tier = fallbackTier
	}
	groups := kiroGroups(record)
	if len(groups) == 0 {
		return errorQuotaInfo(account, tier, "Kiro usage limits are unavailable for this account", time.Now().UnixMilli())
	}
	return baseQuotaInfo(account, tier, "success", groups, time.Now().UnixMilli(), "")
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

func firstNumber(values ...any) (float64, bool) { for _, value := range values { if parsed, ok := parseQuotaNumber(value); ok { return parsed, true } }; return 0, false }
func firstNonNil(values ...any) any { for _, value := range values { if value != nil { return value } }; return nil }
func firstNonEmpty(values ...string) string { for _, value := range values { if strings.TrimSpace(value) != "" { return strings.TrimSpace(value) } }; return "" }
