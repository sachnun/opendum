package freebuff

import (
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
)

type sessionStatus string

const (
	statusDisabled         sessionStatus = "disabled"
	statusNone             sessionStatus = "none"
	statusQueued           sessionStatus = "queued"
	statusActive           sessionStatus = "active"
	statusEnded            sessionStatus = "ended"
	statusSuperseded       sessionStatus = "superseded"
	statusModelLocked      sessionStatus = "model_locked"
	statusModelUnavailable sessionStatus = "model_unavailable"
	statusRateLimited      sessionStatus = "rate_limited"
	statusSpendLimited     sessionStatus = "spend_limited"
	statusIPCapped         sessionStatus = "ip_capped"
	statusCountryBlocked   sessionStatus = "country_blocked"
	statusBanned           sessionStatus = "banned"
)

const (
	retryAfterCap            = 5 * time.Minute
	rateLimitCooldown        = 30 * time.Second
	dailyQuotaCooldown       = 30 * time.Minute
	spendLimitedCooldown     = 30 * time.Minute
	ipCappedCooldown         = 30 * time.Minute
	countryBlockedCooldown   = 24 * time.Hour
	modelUnavailableCooldown = time.Minute
	pollInterval             = 5 * time.Second
	maxWaitingRoomWait       = 60 * time.Second
)

type freeSessionRateLimit struct {
	Model         string  `json:"model"`
	Limit         int     `json:"limit"`
	Period        string  `json:"period"`
	ResetTimeZone string  `json:"resetTimeZone"`
	ResetAt       string  `json:"resetAt"`
	WindowHours   int     `json:"windowHours"`
	RecentCount   float64 `json:"recentCount"`
}

type freeSessionResponse struct {
	Status            string                           `json:"status"`
	InstanceID        string                           `json:"instanceId"`
	Model             string                           `json:"model"`
	Position          int                              `json:"position"`
	QueueDepth        int                              `json:"queueDepth"`
	ExpiresAt         string                           `json:"expiresAt"`
	EstimatedWaitMs   int64                            `json:"estimatedWaitMs"`
	Message           string                           `json:"message"`
	AccessTier        string                           `json:"accessTier"`
	RateLimitsByModel map[string]*freeSessionRateLimit `json:"rateLimitsByModel"`

	retryAfter time.Duration
}

type cachedSession struct {
	status     sessionStatus
	instanceID string
	model      string
	expiresAt  time.Time
	retryAfter time.Duration
}

type sessionBlockedError struct {
	status     string
	retryAfter time.Duration
}

func (e *sessionBlockedError) Error() string {
	if e == nil {
		return "free session blocked"
	}
	if e.status == "" {
		return "free session blocked"
	}
	return "free session " + e.status
}

func (e *sessionBlockedError) cooldown() time.Duration {
	switch e.status {
	case string(statusRateLimited):
		return cooldownWithRetryAfter(e.retryAfter, rateLimitCooldown)
	case string(statusSpendLimited):
		return spendLimitedCooldown
	case string(statusIPCapped):
		return ipCappedCooldown
	case string(statusCountryBlocked):
		return countryBlockedCooldown
	case string(statusModelLocked), string(statusModelUnavailable):
		return modelUnavailableCooldown
	default:
		return 0
	}
}

type waitingRoomError struct {
	position   int
	queueDepth int
	retryAfter time.Duration
}

func (e *waitingRoomError) Error() string {
	if e == nil {
		return "free session queued in waiting room"
	}
	return fmt.Sprintf("free session queued in the waiting room (position %d/%d)", e.position, e.queueDepth)
}

type modelLockedError struct {
	current string
	target  string
}

func (e *modelLockedError) Error() string {
	return fmt.Sprintf("free session is locked to %s; retry with %s", e.current, e.target)
}

type sessionRequestError struct {
	statusCode int
	retryAfter time.Duration
	body       []byte
}

func (e *sessionRequestError) Error() string {
	return fmt.Sprintf("free session request failed with status %d: %s", e.statusCode, strings.TrimSpace(string(e.body)))
}

func cooldownWithRetryAfter(retryAfter, fallback time.Duration) time.Duration {
	if retryAfter <= 0 {
		return fallback
	}
	if retryAfter > retryAfterCap {
		retryAfter = retryAfterCap
	}
	if retryAfter < fallback {
		return fallback
	}
	return retryAfter
}

func parseRetryAfter(h http.Header) time.Duration {
	if raw := strings.TrimSpace(h.Get("retry-after-ms")); raw != "" {
		if ms, err := strconv.Atoi(raw); err == nil && ms > 0 {
			return time.Duration(ms) * time.Millisecond
		}
	}
	raw := strings.TrimSpace(h.Get("Retry-After"))
	if raw == "" {
		return 0
	}
	if seconds, err := strconv.Atoi(raw); err == nil {
		if seconds > 0 {
			return time.Duration(seconds) * time.Second
		}
		return 0
	}
	if when, err := http.ParseTime(raw); err == nil {
		if until := time.Until(when); until > 0 {
			return until
		}
	}
	return 0
}

func parseOptionalTime(value string) time.Time {
	parsed, err := time.Parse(time.RFC3339, strings.TrimSpace(value))
	if err != nil {
		return time.Time{}
	}
	return parsed
}
