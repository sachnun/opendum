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
	"github.com/opendum/opendum/apps/proxy/internal/freebuff"
)

// freebuffQuotaPath returns the read-only session payload that carries the
// account's Freebucks balance and the per-model session limits. It is the same
// request the CLI polls, so it neither admits a session nor spends quota.
const freebuffQuotaPath = "/api/v1/freebuff/session"

type freebuffQuotaSession struct {
	Status     string `json:"status"`
	AccessTier string `json:"accessTier"`
	Message    string `json:"message"`
	Freebucks  struct {
		Balance float64 `json:"balance"`
		Daily   struct {
			Limit     float64 `json:"limit"`
			Spent     float64 `json:"spent"`
			Remaining float64 `json:"remaining"`
			ResetAt   string  `json:"resetAt"`
		} `json:"daily"`
	} `json:"freebucks"`
	RateLimitsByModel map[string]freebuffModelLimit `json:"rateLimitsByModel"`
}

type freebuffModelLimit struct {
	Limit       float64 `json:"limit"`
	RecentCount float64 `json:"recentCount"`
	ResetAt     string  `json:"resetAt"`
}

func (s *Service) fetchFreebuffQuota(ctx context.Context, account appdb.ProviderAccount, accessToken string, forceRefresh bool) accountQuotaInfo {
	token := strings.TrimSpace(accessToken)
	if token == "" {
		return expiredQuotaInfo(account, "Freebuff token is missing. Re-authenticate this account.")
	}
	headers := map[string]string{
		"Authorization": "Bearer " + token,
		"Accept":        "application/json",
		"User-Agent":    freebuff.ClientUserAgent(),
	}
	result, err := s.getQuotaJSON(ctx, account, forceRefresh, "freebuff:session", http.MethodGet, freebuff.DefaultBaseURL+freebuffQuotaPath, headers, nil)
	if err != nil {
		return errorQuotaInfo(account, err.Error(), time.Now().UnixMilli())
	}
	if result.Response.StatusCode == http.StatusUnauthorized {
		return expiredQuotaInfo(account, "Freebuff session is invalid or expired. Re-authenticate this account.")
	}
	var payload freebuffQuotaSession
	parsed := json.Unmarshal(result.Raw, &payload) == nil
	if result.Response.StatusCode < 200 || result.Response.StatusCode >= 300 {
		detail := strings.TrimSpace(payload.Message)
		if detail == "" && parsed {
			detail = strings.TrimSpace(payload.Status)
		}
		if detail == "" {
			detail = strings.TrimSpace(string(result.Raw))
		}
		return errorQuotaInfo(account, fmt.Sprintf("Freebuff quota request failed: HTTP %d %s", result.Response.StatusCode, detail), time.Now().UnixMilli())
	}
	if !parsed {
		return errorQuotaInfo(account, "Freebuff quota response was not valid JSON", time.Now().UnixMilli())
	}
	groups := freebuffQuotaGroups(payload)
	if len(groups) == 0 {
		return errorQuotaInfo(account, "Freebuff quota response did not include usable quota data", time.Now().UnixMilli())
	}
	s.putQuotaJSONCache(ctx, result)
	return baseQuotaInfo(account, "success", groups, time.Now().UnixMilli(), "")
}

func freebuffQuotaGroups(payload freebuffQuotaSession) []quotaGroupDisplay {
	groups := []quotaGroupDisplay{}
	daily := payload.Freebucks.Daily
	if daily.Limit > 0 {
		remaining := math.Max(0, daily.Remaining)
		resetISO := freebuffResetISO(daily.ResetAt)
		groups = append(groups, quotaGroupDisplay{
			Name:              "freebucks-daily",
			DisplayName:       "Freebucks",
			RemainingFraction: clampFraction(remaining / daily.Limit),
			RemainingRequests: displayNumber(remaining),
			MaxRequests:       displayNumber(daily.Limit),
			UsedRequests:      displayNumber(math.Max(0, daily.Spent)),
			PercentUsed:       int(math.Round(clampFraction(1-remaining/daily.Limit) * 100)),
			IsExhausted:       remaining <= 0,
			Confidence:        "high",
			ResetTimeIso:      resetISO,
			ResetInHuman:      formatTimeUntilResetISO(resetISO),
		})
	}

	models := make([]string, 0, len(payload.RateLimitsByModel))
	for model := range payload.RateLimitsByModel {
		models = append(models, model)
	}
	for _, model := range uniqueSortedStrings(models) {
		limit := payload.RateLimitsByModel[model]
		if limit.Limit <= 0 {
			continue
		}
		used := math.Max(0, limit.RecentCount)
		remaining := math.Max(0, limit.Limit-used)
		resetISO := freebuffResetISO(limit.ResetAt)
		groups = append(groups, quotaGroupDisplay{
			Name:              "sessions-" + model,
			DisplayName:       model,
			RemainingFraction: clampFraction(remaining / limit.Limit),
			RemainingRequests: displayNumber(remaining),
			MaxRequests:       displayNumber(limit.Limit),
			UsedRequests:      displayNumber(used),
			PercentUsed:       int(math.Round(clampFraction(used/limit.Limit) * 100)),
			IsExhausted:       remaining <= 0,
			Confidence:        "high",
			ResetTimeIso:      resetISO,
			ResetInHuman:      formatTimeUntilResetISO(resetISO),
		})
	}
	return groups
}

func freebuffResetISO(value string) *string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return nil
	}
	return stringPtr(trimmed)
}
