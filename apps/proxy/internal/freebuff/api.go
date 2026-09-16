package freebuff

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"time"
)

type Error struct {
	Status     int
	Message    string
	RetryAfter time.Duration
}

func (e *Error) Error() string {
	if e == nil {
		return "freebuff error"
	}
	return e.Message
}

func Classify(err error) (*Error, bool) {
	if err == nil {
		return nil, false
	}
	var apiErr *Error
	if errors.As(err, &apiErr) {
		return apiErr, true
	}
	var blocked *sessionBlockedError
	if errors.As(err, &blocked) {
		status := http.StatusTooManyRequests
		switch blocked.status {
		case string(statusCountryBlocked), string(statusBanned):
			status = http.StatusForbidden
		case string(statusModelLocked), string(statusModelUnavailable), string(statusConsentRequired), string(statusSessionLimitReached):
			status = http.StatusConflict
		}
		return &Error{Status: status, Message: blocked.Error(), RetryAfter: blocked.cooldown()}, true
	}
	var waiting *waitingRoomError
	if errors.As(err, &waiting) {
		return &Error{Status: http.StatusServiceUnavailable, Message: waiting.Error(), RetryAfter: waitRetryAfter(waiting.retryAfter)}, true
	}
	var locked *modelLockedError
	if errors.As(err, &locked) {
		return &Error{Status: http.StatusConflict, Message: locked.Error()}, true
	}
	var cd *cooldownError
	if errors.As(err, &cd) {
		return &Error{Status: http.StatusTooManyRequests, Message: cd.Error(), RetryAfter: cd.retryAfter}, true
	}
	var requestErr *sessionRequestError
	if errors.As(err, &requestErr) {
		return &Error{Status: requestErr.statusCode, Message: requestErr.Error(), RetryAfter: requestErr.retryAfter}, true
	}
	return nil, false
}

func waitRetryAfter(value time.Duration) time.Duration {
	if value < time.Second {
		return time.Second
	}
	return value
}

func NewResponse(status int, message string, retryAfter time.Duration) *http.Response {
	body, _ := json.Marshal(map[string]any{"error": map[string]any{"message": message, "type": errorTypeFor(status)}})
	header := http.Header{}
	header.Set("Content-Type", "application/json")
	if retryAfter > 0 {
		seconds := int(retryAfter / time.Second)
		if seconds < 1 {
			seconds = 1
		}
		header.Set("Retry-After", strconv.Itoa(seconds))
	}
	return &http.Response{
		StatusCode: status,
		Status:     http.StatusText(status),
		Header:     header,
		Body:       io.NopCloser(bytes.NewReader(body)),
	}
}

func errorTypeFor(status int) string {
	switch status {
	case http.StatusUnauthorized, http.StatusForbidden:
		return "authentication_error"
	case http.StatusTooManyRequests:
		return "rate_limit_error"
	default:
		return "upstream_error"
	}
}

type releaseBody struct {
	io.ReadCloser
	lease *Lease
}

func (b *releaseBody) Close() error {
	err := b.ReadCloser.Close()
	b.lease.Release()
	return err
}

func WrapBody(body io.ReadCloser, lease *Lease) io.ReadCloser {
	return &releaseBody{ReadCloser: body, lease: lease}
}
