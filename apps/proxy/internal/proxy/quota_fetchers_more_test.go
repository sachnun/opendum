package proxy

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"

	appdb "github.com/opendum/opendum/apps/proxy/internal/db"
)

func TestFetchCodexQuotaFromAPI(t *testing.T) {
	t.Parallel()
	client := &http.Client{Transport: proxyRoundTripFunc(func(req *http.Request) (*http.Response, error) {
		if got := req.Header.Get("ChatGPT-Account-Id"); got != "ws_1" {
			t.Fatalf("ChatGPT-Account-Id = %q, want ws_1", got)
		}
		body := `{"plan_type":"free","rate_limit":{"primary_window":{"used_percent":25,"window_minutes":300,"reset_at":1700000000}}}`
		return quotaResponse(http.StatusOK, body), nil
	})}
	service := &Service{client: client}
	accountID := "ws_1"
	account := appdb.ProviderAccount{ID: "acc_1", Provider: "codex", AccountID: &accountID}

	info := service.fetchCodexQuota(context.Background(), account, "tok", false)
	if info.Status != "success" {
		t.Fatalf("status = %q, want success; error = %q", info.Status, info.Error)
	}
	primary := findQuotaGroup(info.Groups, "primary")
	if primary == nil || primary.PercentUsed != 25 || primary.DisplayName != "5 hour usage" {
		t.Fatalf("primary = %+v", primary)
	}
}

func TestFetchCodexQuotaFallsBackToHeadersOnError(t *testing.T) {
	t.Parallel()
	client := &http.Client{Transport: proxyRoundTripFunc(func(*http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode: http.StatusTooManyRequests,
			Header: http.Header{
				"Content-Type":                   []string{"application/json"},
				"X-Codex-Primary-Used-Percent":   []string{"10"},
				"X-Codex-Primary-Window-Minutes": []string{"300"},
			},
			Body: io.NopCloser(strings.NewReader("rate limited")),
		}, nil
	})}
	service := &Service{client: client}

	info := service.fetchCodexQuota(context.Background(), appdb.ProviderAccount{ID: "acc_1", Provider: "codex"}, "tok", false)
	if info.Status != "success" {
		t.Fatalf("status = %q, want success from headers", info.Status)
	}
	primary := findQuotaGroup(info.Groups, "primary")
	if primary == nil || primary.PercentUsed != 10 {
		t.Fatalf("primary = %+v", primary)
	}
}

func TestFetchCodexQuotaWithoutUsableData(t *testing.T) {
	t.Parallel()
	client := &http.Client{Transport: proxyRoundTripFunc(func(*http.Request) (*http.Response, error) {
		return quotaResponse(http.StatusOK, `{}`), nil
	})}
	service := &Service{client: client}

	info := service.fetchCodexQuota(context.Background(), appdb.ProviderAccount{ID: "acc_1", Provider: "codex"}, "tok", false)
	if info.Status != "error" || !strings.Contains(info.Error, "usable quota data") {
		t.Fatalf("info = %+v, want error about usable quota data", info)
	}
}

func TestFetchKiroQuota(t *testing.T) {
	t.Parallel()
	profile := "arn:aws:codewhisperer:us-east-1:1:profile/x"
	client := &http.Client{Transport: proxyRoundTripFunc(func(req *http.Request) (*http.Response, error) {
		if req.URL.Query().Get("profileArn") != profile {
			t.Fatalf("profileArn = %q, want %q", req.URL.Query().Get("profileArn"), profile)
		}
		return quotaResponse(http.StatusOK, `{"data":{"limits":[{"type":"AI_EDITOR","currentUsage":100,"totalUsageLimit":200}]}}`), nil
	})}
	service := &Service{client: client}
	account := appdb.ProviderAccount{ID: "acc_1", Provider: "kiro", AccountID: &profile}

	info := service.fetchKiroQuota(context.Background(), account, "tok", false)
	if info.Status != "success" {
		t.Fatalf("status = %q, want success; error = %q", info.Status, info.Error)
	}
	if findQuotaGroup(info.Groups, "ai_editor") == nil {
		t.Fatalf("groups = %+v, want ai_editor", info.Groups)
	}
}

func TestFetchKiroQuotaRejectsBadResponses(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name   string
		status int
		body   string
		want   string
	}{
		{"http error", http.StatusForbidden, "nope", "quota endpoint failed"},
		{"invalid json", http.StatusOK, "not json", "not valid JSON"},
		{"no usable limits", http.StatusOK, `{"data":{"limits":[]}}`, "unavailable"},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			client := &http.Client{Transport: proxyRoundTripFunc(func(*http.Request) (*http.Response, error) {
				return quotaResponse(tc.status, tc.body), nil
			})}
			service := &Service{client: client}
			info := service.fetchKiroQuota(context.Background(), appdb.ProviderAccount{ID: "acc_1", Provider: "kiro"}, "tok", false)
			if info.Status != "error" || !strings.Contains(info.Error, tc.want) {
				t.Fatalf("info = %+v, want error containing %q", info, tc.want)
			}
		})
	}
}

func TestFetchAntigravityQuotaRequiresProjectID(t *testing.T) {
	t.Parallel()
	service := &Service{client: &http.Client{Transport: proxyRoundTripFunc(func(*http.Request) (*http.Response, error) {
		t.Fatal("upstream should not be called without project id")
		return nil, nil
	})}}
	info := service.fetchAntigravityQuota(context.Background(), appdb.ProviderAccount{ID: "acc_1", Provider: "antigravity"}, "tok", false)
	if info.Status != "error" || !strings.Contains(info.Error, "projectId") {
		t.Fatalf("info = %+v, want projectId error", info)
	}
}

func TestFetchAntigravityQuotaSuccessAndFallback(t *testing.T) {
	t.Parallel()
	projectID := "proj_1"

	t.Run("success on first endpoint", func(t *testing.T) {
		t.Parallel()
		calls := 0
		client := &http.Client{Transport: proxyRoundTripFunc(func(*http.Request) (*http.Response, error) {
			calls++
			return quotaResponse(http.StatusOK, `{"models":{"claude-opus-4-6-thinking":{"quotaInfo":{"remainingFraction":0.5}}}}`), nil
		})}
		service := &Service{client: client}
		info := service.fetchAntigravityQuota(context.Background(), appdb.ProviderAccount{ID: "acc_1", Provider: "antigravity", ProjectID: &projectID}, "tok", false)
		if info.Status != "success" {
			t.Fatalf("status = %q, want success; error = %q", info.Status, info.Error)
		}
		if calls != 1 {
			t.Fatalf("calls = %d, want 1", calls)
		}
	})

	t.Run("all endpoints fail", func(t *testing.T) {
		t.Parallel()
		client := &http.Client{Transport: proxyRoundTripFunc(func(*http.Request) (*http.Response, error) {
			return quotaResponse(http.StatusServiceUnavailable, "down"), nil
		})}
		service := &Service{client: client}
		info := service.fetchAntigravityQuota(context.Background(), appdb.ProviderAccount{ID: "acc_1", Provider: "antigravity", ProjectID: &projectID}, "tok", false)
		if info.Status != "error" || !strings.Contains(info.Error, "Failed to fetch Antigravity") {
			t.Fatalf("info = %+v, want aggregated failure error", info)
		}
	})
}

func TestFetchZenmuxQuotaRequiresPlatformKey(t *testing.T) {
	t.Parallel()
	service := &Service{client: &http.Client{Transport: proxyRoundTripFunc(func(*http.Request) (*http.Response, error) {
		t.Fatal("upstream should not be called without platform key")
		return nil, nil
	})}}
	info := service.fetchZenmuxQuota(context.Background(), appdb.ProviderAccount{ID: "acc_1", Provider: "zenmux"}, false)
	if info.Status != "expired" || !strings.Contains(info.Error, "Platform key") {
		t.Fatalf("info = %+v, want platform key error", info)
	}
}
