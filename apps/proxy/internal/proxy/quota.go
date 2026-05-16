package proxy

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"sort"
	"strings"
	"time"

	appdb "github.com/opendum/opendum/apps/proxy/internal/db"
)

const internalQuotaMaxBodyBytes = 64 << 10

type quotaRequest struct {
	UserID    string `json:"userId"`
	Provider  string `json:"provider"`
	AccountID string `json:"accountId"`
}

type quotaGroupDisplay struct {
	Name              string   `json:"name"`
	DisplayName       string   `json:"displayName"`
	Models            []string `json:"-"`
	RemainingFraction float64  `json:"remainingFraction"`
	RemainingRequests float64  `json:"remainingRequests"`
	MaxRequests       float64  `json:"maxRequests"`
	UsedRequests      float64  `json:"usedRequests"`
	PercentUsed       int      `json:"-"`
	IsExhausted       bool     `json:"-"`
	IsEstimated       bool     `json:"-"`
	Confidence        string   `json:"-"`
	ResetTimeIso      *string  `json:"resetTimeIso"`
	ResetInHuman      *string  `json:"resetInHuman"`
	RemainingLabel    *string  `json:"-"`
}

type accountQuotaInfo struct {
	Tier   string              `json:"tier"`
	Status string              `json:"status"`
	Error  string              `json:"error,omitempty"`
	Groups []quotaGroupDisplay `json:"groups"`
}

func (s *Service) InternalQuota(w http.ResponseWriter, r *http.Request) {
	rawBody, err := io.ReadAll(http.MaxBytesReader(w, r.Body, internalQuotaMaxBodyBytes))
	if err != nil {
		writeQuotaJSON(w, http.StatusBadRequest, map[string]any{"success": false, "error": "Invalid quota payload"})
		return
	}
	if !s.validateInternalSignature(r, "/internal/quota", rawBody) {
		writeQuotaJSON(w, http.StatusUnauthorized, map[string]any{"success": false, "error": "Invalid internal quota signature"})
		return
	}

	var input quotaRequest
	decoder := json.NewDecoder(bytes.NewReader(rawBody))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil {
		writeQuotaJSON(w, http.StatusBadRequest, map[string]any{"success": false, "error": "Invalid quota payload"})
		return
	}
	input.UserID = strings.TrimSpace(input.UserID)
	input.Provider = strings.TrimSpace(input.Provider)
	input.AccountID = strings.TrimSpace(input.AccountID)
	if input.UserID == "" || input.Provider == "" || input.AccountID == "" {
		writeQuotaJSON(w, http.StatusBadRequest, map[string]any{"success": false, "error": "userId, provider, and accountId are required"})
		return
	}

	account, err := s.loadQuotaAccount(r.Context(), input)
	if err != nil {
		writeQuotaJSON(w, http.StatusNotFound, map[string]any{"success": false, "error": "Account not found"})
		return
	}
	result, err := s.fetchAccountQuota(r.Context(), account)
	if err != nil {
		writeQuotaJSON(w, http.StatusOK, map[string]any{"success": false, "error": err.Error()})
		return
	}
	writeQuotaJSON(w, http.StatusOK, map[string]any{"success": true, "data": result})
}

func (s *Service) validateInternalSignature(r *http.Request, path string, body []byte) bool {
	if strings.TrimSpace(s.secret) == "" {
		return false
	}
	timestampValue := strings.TrimSpace(r.Header.Get("X-Opendum-Internal-Timestamp"))
	signatureValue := strings.TrimSpace(r.Header.Get("X-Opendum-Internal-Signature"))
	if timestampValue == "" || signatureValue == "" {
		return false
	}
	timestamp, err := strconv.ParseInt(timestampValue, 10, 64)
	if err != nil {
		return false
	}
	requestTime := time.Unix(timestamp, 0)
	if time.Since(requestTime) > 2*time.Minute || time.Until(requestTime) > 2*time.Minute {
		return false
	}
	provided, err := hex.DecodeString(signatureValue)
	if err != nil {
		return false
	}
	mac := hmac.New(sha256.New, []byte(s.secret))
	_, _ = mac.Write([]byte(timestampValue))
	_, _ = mac.Write([]byte("\n"))
	_, _ = mac.Write([]byte(path))
	_, _ = mac.Write([]byte("\n"))
	_, _ = mac.Write(body)
	return hmac.Equal(provided, mac.Sum(nil))
}

func (s *Service) loadQuotaAccount(ctx context.Context, input quotaRequest) (appdb.ProviderAccount, error) {
	var account appdb.ProviderAccount
	err := s.db.NewSelect().Model(&account).
		Column("id", "userId", "provider", "name", "accessToken", "refreshToken", "expiresAt", "apiKey", "projectId", "tier", "accountId", "email", "isActive", "lastUsedAt").
		Where("id = ?", input.AccountID).
		Where("\"userId\" = ?", input.UserID).
		Where("provider = ?", input.Provider).
		Limit(1).
		Scan(ctx)
	return account, err
}

func (s *Service) fetchAccountQuota(ctx context.Context, account appdb.ProviderAccount) (accountQuotaInfo, error) {
	if account.Provider == "openrouter" {
		return s.fetchOpenRouterQuota(ctx, account), nil
	}
	providerImpl, ok := s.providerRegistry.Get(account.Provider)
	if !ok {
		return accountQuotaInfo{}, fmt.Errorf("provider %s is not supported for quota", account.Provider)
	}
	credentials, requestAccount, err := s.credentialsForAccount(ctx, account, providerImpl)
	if err != nil {
		return expiredQuotaInfo(account, quotaFallbackTier(account), "Token expired - please re-authenticate"), nil
	}

	switch account.Provider {
	case "antigravity":
		return s.fetchAntigravityQuota(ctx, requestAccount, credentials), nil
	case "copilot":
		return s.fetchCopilotQuota(ctx, requestAccount, credentials), nil
	case "codex":
		return s.fetchCodexQuota(ctx, requestAccount, credentials), nil
	case "gemini_cli":
		return s.fetchGeminiCLIQuota(ctx, requestAccount, credentials), nil
	case "kiro":
		return s.fetchKiroQuota(ctx, requestAccount, credentials), nil
	default:
		return accountQuotaInfo{}, fmt.Errorf("provider %s is not supported for quota", account.Provider)
	}
}

func quotaFallbackTier(account appdb.ProviderAccount) string {
	if account.Tier != nil && strings.TrimSpace(*account.Tier) != "" {
		return strings.TrimSpace(*account.Tier)
	}
	return "free"
}

func baseQuotaInfo(_ appdb.ProviderAccount, tier, status string, groups []quotaGroupDisplay, _ int64, message string) accountQuotaInfo {
	return accountQuotaInfo{Tier: tier, Status: status, Error: message, Groups: groups}
}

func expiredQuotaInfo(account appdb.ProviderAccount, tier, message string) accountQuotaInfo {
	return baseQuotaInfo(account, tier, "expired", []quotaGroupDisplay{}, time.Now().UnixMilli(), message)
}

func errorQuotaInfo(account appdb.ProviderAccount, tier, message string, fetchedAt int64) accountQuotaInfo {
	return baseQuotaInfo(account, tier, "error", []quotaGroupDisplay{}, fetchedAt, message)
}

func writeQuotaJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func clampFraction(value float64) float64 {
	return math.Max(0, math.Min(1, value))
}

func displayNumber(value float64) float64 {
	if math.Abs(value-math.Round(value)) < 0.001 {
		return math.Round(value)
	}
	return math.Round(value*100) / 100
}

func formatTimeUntilReset(resetTimestamp int64) *string {
	if resetTimestamp <= 0 {
		return nil
	}
	diff := resetTimestamp - time.Now().UnixMilli()
	if diff <= 0 {
		value := "resetting..."
		return &value
	}
	hours := diff / int64(time.Hour/time.Millisecond)
	minutes := (diff % int64(time.Hour/time.Millisecond)) / int64(time.Minute/time.Millisecond)
	var value string
	if hours >= 24 {
		days := hours / 24
		remainingHours := hours % 24
		if remainingHours > 0 {
			value = fmt.Sprintf("%dd %dh", days, remainingHours)
		} else {
			value = fmt.Sprintf("%dd", days)
		}
	} else if hours > 0 {
		if minutes > 0 {
			value = fmt.Sprintf("%dh %dm", hours, minutes)
		} else {
			value = fmt.Sprintf("%dh", hours)
		}
	} else {
		value = fmt.Sprintf("%dm", minutes)
	}
	return &value
}

func formatTimeUntilResetISO(resetISO *string) *string {
	if resetISO == nil || strings.TrimSpace(*resetISO) == "" {
		return nil
	}
	parsed, err := time.Parse(time.RFC3339Nano, *resetISO)
	if err != nil {
		return nil
	}
	return formatTimeUntilReset(parsed.UnixMilli())
}

func stringPtr(value string) *string { return &value }

func intPtrValue(value int64) *int64 { return &value }

func getJSON(ctx context.Context, client *http.Client, method, target string, headers map[string]string, body any) (*http.Response, []byte, error) {
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return nil, nil, err
		}
		reader = bytes.NewReader(encoded)
	}
	req, err := http.NewRequestWithContext(ctx, method, target, reader)
	if err != nil {
		return nil, nil, err
	}
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, nil, err
	}
	defer resp.Body.Close()
	raw := readQuotaLimit(resp.Body, 1<<20)
	return resp, []byte(raw), nil
}

func readQuotaLimit(r io.Reader, limit int64) string {
	if r == nil {
		return ""
	}
	data, _ := io.ReadAll(io.LimitReader(r, limit))
	return string(data)
}

func lastPathSegment(value string) string {
	if idx := strings.LastIndex(value, "/"); idx >= 0 {
		return value[idx+1:]
	}
	return value
}

func uniqueSortedStrings(values []string) []string {
	seen := map[string]struct{}{}
	out := []string{}
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}
	sort.Strings(out)
	return out
}

func parseQuotaNumber(value any) (float64, bool) {
	switch typed := value.(type) {
	case float64:
		return typed, !math.IsNaN(typed) && !math.IsInf(typed, 0)
	case int:
		return float64(typed), true
	case int64:
		return float64(typed), true
	case string:
		parsed, err := strconvParseFloat(typed)
		return parsed, err == nil
	default:
		return 0, false
	}
}

func strconvParseFloat(value string) (float64, error) {
	return strconv.ParseFloat(strings.TrimSpace(value), 64)
}

func parseQuotaString(value any) string {
	if typed, ok := value.(string); ok {
		return strings.TrimSpace(typed)
	}
	return ""
}

func parseQuotaRecord(value any) map[string]any {
	if typed, ok := value.(map[string]any); ok {
		return typed
	}
	return nil
}

func parseQuotaArray(value any) []any {
	if typed, ok := value.([]any); ok {
		return typed
	}
	return nil
}

func encodeQuery(base string, values url.Values) string {
	if len(values) == 0 {
		return base
	}
	return base + "?" + values.Encode()
}
