package proxy

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/opendum/opendum/apps/proxy/internal/cryptojs"
	appdb "github.com/opendum/opendum/apps/proxy/internal/db"
)

type proxyRoundTripFunc func(*http.Request) (*http.Response, error)

func (f proxyRoundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) { return f(req) }

func quotaResponse(status int, body string) *http.Response {
	return &http.Response{
		StatusCode: status,
		Header:     http.Header{"Content-Type": []string{"application/json"}},
		Body:       io.NopCloser(strings.NewReader(body)),
	}
}

func encryptedToken(t *testing.T, secret, value string) string {
	t.Helper()
	token, err := cryptojs.Encrypt(secret, value)
	if err != nil {
		t.Fatalf("encrypt token: %v", err)
	}
	return token
}

func TestFetchOpenRouterQuotaSuccess(t *testing.T) {
	t.Parallel()
	const secret = "test-secret"
	var requests []*http.Request
	client := &http.Client{Transport: proxyRoundTripFunc(func(req *http.Request) (*http.Response, error) {
		requests = append(requests, req)
		switch {
		case strings.HasSuffix(req.URL.Path, "/key"):
			return quotaResponse(http.StatusOK, `{"data":{"limit":100,"limit_remaining":25,"usage":75}}`), nil
		case strings.HasSuffix(req.URL.Path, "/credits"):
			return quotaResponse(http.StatusOK, `{"data":{"total_credits":10,"total_usage":4}}`), nil
		default:
			return quotaResponse(http.StatusNotFound, `{}`), nil
		}
	})}

	service := &Service{secret: secret, client: client}
	account := appdb.ProviderAccount{ID: "acc_1", Provider: "openrouter", AccessToken: encryptedToken(t, secret, "sk-or-key")}

	info := service.fetchOpenRouterQuota(context.Background(), account, false)
	if info.Status != "success" {
		t.Fatalf("status = %q, want success; error = %q", info.Status, info.Error)
	}
	if findQuotaGroup(info.Groups, "account-credits") == nil || findQuotaGroup(info.Groups, "key-limit") == nil {
		t.Fatalf("groups = %+v, want account-credits and key-limit", info.Groups)
	}
	if len(requests) != 2 {
		t.Fatalf("requests = %d, want 2", len(requests))
	}
	for _, req := range requests {
		if got := req.Header.Get("Authorization"); got != "Bearer sk-or-key" {
			t.Fatalf("Authorization = %q, want bearer api key", got)
		}
	}
}

func TestFetchOpenRouterQuotaDecryptFailure(t *testing.T) {
	t.Parallel()
	service := &Service{secret: "test-secret", client: &http.Client{Transport: proxyRoundTripFunc(func(*http.Request) (*http.Response, error) {
		t.Fatal("upstream should not be called when token cannot be decrypted")
		return nil, nil
	})}}
	account := appdb.ProviderAccount{ID: "acc_1", Provider: "openrouter", AccessToken: "not-valid-base64!!"}

	info := service.fetchOpenRouterQuota(context.Background(), account, false)
	if info.Status != "expired" {
		t.Fatalf("status = %q, want expired", info.Status)
	}
	if !strings.Contains(info.Error, "reconnect") {
		t.Fatalf("error = %q, want reconnect hint", info.Error)
	}
}

func TestFetchOpenRouterQuotaAllEndpointsFail(t *testing.T) {
	t.Parallel()
	client := &http.Client{Transport: proxyRoundTripFunc(func(*http.Request) (*http.Response, error) {
		return quotaResponse(http.StatusInternalServerError, "boom"), nil
	})}
	service := &Service{secret: "test-secret", client: client}
	account := appdb.ProviderAccount{ID: "acc_1", Provider: "openrouter", AccessToken: encryptedToken(t, "test-secret", "sk-or-key")}

	info := service.fetchOpenRouterQuota(context.Background(), account, false)
	if info.Status != "error" || !strings.Contains(info.Error, "OpenRouter") {
		t.Fatalf("info = %+v, want error mentioning OpenRouter", info)
	}
}

func TestFetchOpenRouterQuotaPartialFailureStillSucceeds(t *testing.T) {
	t.Parallel()
	client := &http.Client{Transport: proxyRoundTripFunc(func(req *http.Request) (*http.Response, error) {
		if strings.HasSuffix(req.URL.Path, "/key") {
			return quotaResponse(http.StatusInternalServerError, "boom"), nil
		}
		return quotaResponse(http.StatusOK, `{"data":{"total_credits":10,"total_usage":4}}`), nil
	})}
	service := &Service{secret: "test-secret", client: client}
	account := appdb.ProviderAccount{ID: "acc_1", Provider: "openrouter", AccessToken: encryptedToken(t, "test-secret", "sk-or-key")}

	info := service.fetchOpenRouterQuota(context.Background(), account, false)
	if info.Status != "success" {
		t.Fatalf("status = %q, want success", info.Status)
	}
	if findQuotaGroup(info.Groups, "account-credits") == nil {
		t.Fatalf("groups = %+v, want account-credits from credits endpoint", info.Groups)
	}
	if findQuotaGroup(info.Groups, "key-limit") != nil {
		t.Fatalf("groups = %+v, key-limit should be absent when key endpoint failed", info.Groups)
	}
}

func TestFetchOpenRouterQuotaInvalidDataObject(t *testing.T) {
	t.Parallel()
	client := &http.Client{Transport: proxyRoundTripFunc(func(*http.Request) (*http.Response, error) {
		return quotaResponse(http.StatusOK, `{"no_data":true}`), nil
	})}
	service := &Service{secret: "test-secret", client: client}
	account := appdb.ProviderAccount{ID: "acc_1", Provider: "openrouter", AccessToken: encryptedToken(t, "test-secret", "sk-or-key")}

	info := service.fetchOpenRouterQuota(context.Background(), account, false)
	if info.Status != "error" || !strings.Contains(info.Error, "data object") {
		t.Fatalf("info = %+v, want error about missing data object", info)
	}
}
