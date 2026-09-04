package proxy

import (
	"context"

	appdb "github.com/opendum/opendum/apps/proxy/internal/db"
)

type quotaFetcher func(ctx context.Context, account appdb.ProviderAccount, accessToken string, forceRefresh bool) accountQuotaInfo

var quotaProvidersWithoutToken = map[string]struct{}{
	"openrouter":  {},
	"siliconflow": {},
}

func (s *Service) quotaFetcherRegistry() map[string]quotaFetcher {
	if s.quotaFetchers != nil {
		return s.quotaFetchers
	}
	s.quotaFetchers = map[string]quotaFetcher{
		"openrouter": func(ctx context.Context, account appdb.ProviderAccount, _ string, forceRefresh bool) accountQuotaInfo {
			return s.fetchOpenRouterQuota(ctx, account, forceRefresh)
		},
		"siliconflow": func(ctx context.Context, account appdb.ProviderAccount, _ string, forceRefresh bool) accountQuotaInfo {
			return s.fetchSiliconFlowQuota(ctx, account, forceRefresh)
		},
		"antigravity": s.fetchAntigravityQuota,
		"codex":       s.fetchCodexQuota,
		"kiro":        s.fetchKiroQuota,
		"zenmux": func(ctx context.Context, account appdb.ProviderAccount, _ string, forceRefresh bool) accountQuotaInfo {
			return s.fetchZenmuxQuota(ctx, account, forceRefresh)
		},
	}
	return s.quotaFetchers
}

func (s *Service) quotaFetcherFor(provider string) (quotaFetcher, bool) {
	fetcher, ok := s.quotaFetcherRegistry()[provider]
	return fetcher, ok
}
