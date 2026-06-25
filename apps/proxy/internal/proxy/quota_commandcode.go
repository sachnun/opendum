package proxy

import (
	"context"
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

const (
	commandCodeAPIBaseURL = "https://api.commandcode.ai"
)

// Per-plan allowance for Command Code, expressed in USD credits per billing
// period. Values come from the published Pricing & Limits page and are used
// only to normalize the upstream-reported usage into a fraction of the plan
// the user is on. Opendum does not bill against these numbers — the upstream
// is the source of truth.
var commandCodePlanAllowance = map[string]struct {
	label    string
	allowUSD float64
}{
	"individual-go":      {label: "go", allowUSD: 10},
	"individual-max-10x": {label: "max-10x", allowUSD: 150},
	"individual-max-20x": {label: "max-20x", allowUSD: 300},
	"team-pro":           {label: "team-pro", allowUSD: 40},
}

func commandCodeTierFromPlanID(planID string) (label string, allowance float64, known bool) {
	cleaned := strings.ToLower(strings.TrimSpace(planID))
	if cleaned == "" {
		return "", 0, false
	}
	entry, ok := commandCodePlanAllowance[cleaned]
	if !ok {
		return cleaned, 0, false
	}
	return entry.label, entry.allowUSD, true
}

type commandCodeWhoami struct {
	Success bool `json:"success"`
	User    *struct {
		ID       string `json:"id"`
		Name     string `json:"name"`
		UserName string `json:"userName"`
	} `json:"user"`
	Org *struct {
		ID string `json:"id"`
	} `json:"org"`
	Error *struct {
		Message string `json:"message"`
	} `json:"error"`
}

type commandCodeSubscriptionResponse struct {
	Success bool `json:"success"`
	Data    *struct {
		ID                 string `json:"id"`
		Status             string `json:"status"`
		PlanID             string `json:"planId"`
		CurrentPeriodStart string `json:"currentPeriodStart"`
		CurrentPeriodEnd   string `json:"currentPeriodEnd"`
		CancelAtPeriodEnd  bool   `json:"cancelAtPeriodEnd"`
	} `json:"data"`
	Error *struct {
		Message string `json:"message"`
	} `json:"error"`
}

type commandCodeWindowLimit struct {
	Used    float64 `json:"used"`
	Cap     float64 `json:"cap"`
	ResetAt string  `json:"resetAt"`
}

type commandCodeCreditsResponse struct {
	Credits *struct {
		BelowThreshold   bool    `json:"belowThreshold"`
		CreditThreshold  float64 `json:"creditThreshold"`
		MonthlyCredits   float64 `json:"monthlyCredits"`
		PurchasedCredits float64 `json:"purchasedCredits"`
		FreeCredits      float64 `json:"freeCredits"`
	} `json:"credits"`
	WindowLimits *struct {
		Limited  bool                    `json:"limited"`
		Exceeded *string                 `json:"exceeded"`
		FiveHour *commandCodeWindowLimit `json:"fiveHour"`
		Weekly   *commandCodeWindowLimit `json:"weekly"`
	} `json:"windowLimits"`
	Error *struct {
		Message string `json:"message"`
	} `json:"error"`
}

type commandCodeUsageSummary struct {
	TotalCount          int     `json:"totalCount"`
	TotalCost           float64 `json:"totalCost"`
	AverageCost         float64 `json:"averageCost"`
	SuccessRate         float64 `json:"successRate"`
	CompletedCount      int     `json:"completedCount"`
	FailedCount         int     `json:"failedCount"`
	TotalTokensIn       int64   `json:"totalTokensIn"`
	TotalTokensOut      int64   `json:"totalTokensOut"`
	TotalTokens         int64   `json:"totalTokens"`
	TotalCredits        float64 `json:"totalCredits"`
	TotalFreeCredits    float64 `json:"totalFreeCredits"`
	TotalMonthlyCredits float64 `json:"totalMonthlyCredits"`
	PeriodBasis         string  `json:"periodBasis"`
}

func commandCodeHeaders(apiKey string) map[string]string {
	return map[string]string{
		"Authorization":          "Bearer " + apiKey,
		"Accept":                 "application/json",
		"x-command-code-version": "0.38.7",
		"x-cli-environment":      "production",
		"x-project-slug":         "command-code",
	}
}

func (s *Service) commandCodeGet(ctx context.Context, account appdb.ProviderAccount, forceRefresh bool, cacheName, target string, headers map[string]string) (quotaJSONResult, error) {
	// cryptojs decryption mirrors how openrouter and siliconflow obtain the
	// bearer token in fetchOpenRouterQuota/fetchSiliconFlowQuota.
	apiKey, err := cryptojs.Decrypt(s.secret, account.AccessToken)
	if err != nil {
		return quotaJSONResult{}, fmt.Errorf("decrypt access token: %w", err)
	}
	return s.getQuotaJSON(ctx, account, forceRefresh, cacheName, http.MethodGet, target, commandCodeHeaders(strings.TrimSpace(apiKey)), nil)
}

func (s *Service) fetchCommandCodeQuota(ctx context.Context, account appdb.ProviderAccount, credentials string, forceRefresh bool) accountQuotaInfo {
	apiKey := strings.TrimSpace(credentials)
	if apiKey == "" {
		return expiredQuotaInfo(account, "Command Code API key is missing. Reconnect this account.")
	}

	base := commandCodeAPIBaseURL
	headersForCaller := commandCodeHeaders(apiKey)

	// Step 1 — confirm the API key resolves to a real identity. Using the
	// pre-decrypted credentials string keeps consistency with the other
	// switch-case fetchers (codex, kiro) that also receive a
	// plaintext token via credentialsForAccount.
	whoamiResult, err := s.getQuotaJSON(ctx, account, forceRefresh, "commandcode:whoami", http.MethodGet, base+"/alpha/whoami", headersForCaller, nil)
	if err != nil {
		return errorQuotaInfo(account, fmt.Sprintf("Command Code whoami request failed: %s", err.Error()), time.Now().UnixMilli())
	}
	if whoamiResult.Response.StatusCode == http.StatusUnauthorized || whoamiResult.Response.StatusCode == http.StatusForbidden {
		return expiredQuotaInfo(account, "Command Code API key is invalid or revoked. Please reconnect this account.")
	}
	if whoamiResult.Response.StatusCode < 200 || whoamiResult.Response.StatusCode >= 300 {
		return errorQuotaInfo(account, fmt.Sprintf("Command Code whoami returned HTTP %d", whoamiResult.Response.StatusCode), time.Now().UnixMilli())
	}
	var whoami commandCodeWhoami
	if err := json.Unmarshal(whoamiResult.Raw, &whoami); err != nil {
		return errorQuotaInfo(account, "Command Code whoami response was not valid JSON", time.Now().UnixMilli())
	}
	if !whoami.Success || whoami.User == nil {
		return expiredQuotaInfo(account, "Command Code whoami did not confirm the account. Please reconnect this account.")
	}
	s.putQuotaJSONCache(ctx, whoamiResult)

	// Step 2 — subscription metadata (plan + billing period + status).
	subscriptionResult, err := s.getQuotaJSON(ctx, account, forceRefresh, "commandcode:subscription", http.MethodGet, base+"/alpha/billing/subscriptions", headersForCaller, nil)
	if err != nil {
		return errorQuotaInfo(account, fmt.Sprintf("Command Code subscription request failed: %s", err.Error()), time.Now().UnixMilli())
	}
	if subscriptionResult.Response.StatusCode < 200 || subscriptionResult.Response.StatusCode >= 300 {
		return errorQuotaInfo(account, fmt.Sprintf("Command Code subscription returned HTTP %d", subscriptionResult.Response.StatusCode), time.Now().UnixMilli())
	}
	var subscription commandCodeSubscriptionResponse
	if err := json.Unmarshal(subscriptionResult.Raw, &subscription); err != nil {
		return errorQuotaInfo(account, "Command Code subscription response was not valid JSON", time.Now().UnixMilli())
	}
	if !subscription.Success || subscription.Data == nil {
		return errorQuotaInfo(account, "Command Code subscription response did not include subscription data", time.Now().UnixMilli())
	}
	if !strings.EqualFold(strings.TrimSpace(subscription.Data.Status), "active") {
		return expiredQuotaInfo(account, fmt.Sprintf("Command Code subscription status is %q. Renew or upgrade at commandcode.ai/billing.", strings.TrimSpace(subscription.Data.Status)))
	}
	s.putQuotaJSONCache(ctx, subscriptionResult)

	tierLabel, allowance, tierKnown := commandCodeTierFromPlanID(subscription.Data.PlanID)

	// Step 3 — current spend and remaining entitlement in the billing period.
	creditsResult, err := s.getQuotaJSON(ctx, account, forceRefresh, "commandcode:billing-credits", http.MethodGet, base+"/alpha/billing/credits", headersForCaller, nil)
	if err != nil {
		return errorQuotaInfo(account, fmt.Sprintf("Command Code credits request failed: %s", err.Error()), time.Now().UnixMilli())
	}
	if creditsResult.Response.StatusCode < 200 || creditsResult.Response.StatusCode >= 300 {
		return errorQuotaInfo(account, fmt.Sprintf("Command Code credits returned HTTP %d", creditsResult.Response.StatusCode), time.Now().UnixMilli())
	}
	var credits commandCodeCreditsResponse
	if err := json.Unmarshal(creditsResult.Raw, &credits); err != nil || credits.Credits == nil {
		return errorQuotaInfo(account, "Command Code credits response was not valid JSON or did not include a credits object", time.Now().UnixMilli())
	}
	s.putQuotaJSONCache(ctx, creditsResult)

	remainingEntitlement := credits.Credits.MonthlyCredits + credits.Credits.PurchasedCredits + credits.Credits.FreeCredits
	if remainingEntitlement < 0 {
		remainingEntitlement = 0
	}

	// Step 4 — usage summary restricted to the current billing window so the
	// totalCost field tracks the same period the entitlement belongs to.
	usageURL := base + "/alpha/usage/summary"
	if since := strings.TrimSpace(subscription.Data.CurrentPeriodStart); since != "" {
		usageURL = usageURL + "?since=" + url.QueryEscape(since)
	}
	usageResult, err := s.getQuotaJSON(ctx, account, forceRefresh, "commandcode:usage-summary", http.MethodGet, usageURL, headersForCaller, nil)
	if err != nil {
		return errorQuotaInfo(account, fmt.Sprintf("Command Code usage request failed: %s", err.Error()), time.Now().UnixMilli())
	}
	if usageResult.Response.StatusCode < 200 || usageResult.Response.StatusCode >= 300 {
		return errorQuotaInfo(account, fmt.Sprintf("Command Code usage returned HTTP %d", usageResult.Response.StatusCode), time.Now().UnixMilli())
	}
	var usage commandCodeUsageSummary
	if err := json.Unmarshal(usageResult.Raw, &usage); err != nil {
		return errorQuotaInfo(account, "Command Code usage response was not valid JSON", time.Now().UnixMilli())
	}
	if usage.TotalCost < 0 {
		return errorQuotaInfo(account, "Command Code usage response carried a negative total cost", time.Now().UnixMilli())
	}
	s.putQuotaJSONCache(ctx, usageResult)

	// Build the displayed fraction relative to the plan allowance when we
	// recognise the planId. Otherwise fall back to remaining-entitlement as
	// the denominator so unknown tiers still render a sensible progress bar.
	denominator := allowance
	if denominator <= 0 {
		denominator = remainingEntitlement + usage.TotalCost
	}
	remainingUSD := math.Max(0, denominator-usage.TotalCost)
	fraction := 1.0
	if denominator > 0 {
		fraction = clampFraction(remainingUSD / denominator)
	}

	displayName := fmt.Sprintf("Plan balance (%s)", tierLabel)
	if !tierKnown {
		displayName = fmt.Sprintf("Plan balance (unknown — %s)", strings.TrimSpace(subscription.Data.PlanID))
	} else if tierLabel != "go" {
		displayName = fmt.Sprintf("Plan balance (%s — tier mismatch)", tierLabel)
	}

	var resetISO *string
	var resetHuman *string
	if trimmed := strings.TrimSpace(subscription.Data.CurrentPeriodEnd); trimmed != "" {
		resetISO = stringPtr(trimmed)
		resetHuman = formatTimeUntilResetISO(resetISO)
	}

	remainingLabel := fmt.Sprintf("$%.4f / $%.2f", math.Max(0, remainingEntitlement), denominator)
	if !tierKnown {
		remainingLabel = fmt.Sprintf("$%.4f remaining", math.Max(0, remainingEntitlement))
	}

	confidence := "high"
	if !tierKnown {
		confidence = "medium"
	} else if tierLabel != "go" {
		confidence = "medium"
	}

	group := quotaGroupDisplay{
		Name:              "command-code-plan",
		DisplayName:       displayName,
		RemainingFraction: fraction,
		RemainingRequests: displayNumber(remainingUSD),
		MaxRequests:       displayNumber(denominator),
		UsedRequests:      displayNumber(usage.TotalCost),
		ResetTimeIso:      resetISO,
		ResetInHuman:      resetHuman,
		PercentUsed:       int(math.Round(clampFraction(usage.TotalCost/denominator) * 100)),
		IsExhausted:       remainingUSD <= 0.0001,
		IsEstimated:       false,
		Confidence:        confidence,
		RemainingLabel:    &remainingLabel,
	}

	groups := []quotaGroupDisplay{group}

	if credits.WindowLimits != nil {
		if wh := credits.WindowLimits.FiveHour; wh != nil && wh.Cap > 0 {
			groups = append(groups, buildWindowLimitGroup("five-hour", "5-Hour Window", wh))
		}
		if wh := credits.WindowLimits.Weekly; wh != nil && wh.Cap > 0 {
			groups = append(groups, buildWindowLimitGroup("weekly", "7-Day Window", wh))
		}
	}

	return baseQuotaInfo(account, "success", groups, time.Now().UnixMilli(), "")
}

func buildWindowLimitGroup(name, display string, w *commandCodeWindowLimit) quotaGroupDisplay {
	remaining := math.Max(0, w.Cap-w.Used)
	fraction := clampFraction(remaining / w.Cap)
	resetISO := stringPtr(w.ResetAt)
	remainingLabel := fmt.Sprintf("%s / %s requests", formatFloat(remaining), formatFloat(w.Cap))
	return quotaGroupDisplay{
		Name:              name,
		DisplayName:       display,
		RemainingFraction: fraction,
		RemainingRequests: displayNumber(remaining),
		MaxRequests:       displayNumber(w.Cap),
		UsedRequests:      displayNumber(w.Used),
		ResetTimeIso:      resetISO,
		ResetInHuman:      formatTimeUntilResetISO(resetISO),
		PercentUsed:       int(math.Round(clampFraction(w.Used/w.Cap) * 100)),
		IsExhausted:       fraction <= 0,
		RemainingLabel:    &remainingLabel,
	}
}
