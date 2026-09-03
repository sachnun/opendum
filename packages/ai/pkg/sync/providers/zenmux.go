package providers

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/opendum/opendum/packages/ai/pkg/sync"
)

type ZenMuxFetcher struct {
	Client *http.Client
}

func NewZenMuxFetcher() *ZenMuxFetcher {
	return &ZenMuxFetcher{
		Client: &http.Client{Timeout: 30 * time.Second},
	}
}

func (f *ZenMuxFetcher) Name() string {
	return "zenmux"
}

func (f *ZenMuxFetcher) Fetch(ctx context.Context) (map[string]string, error) {
	// 1. Get plans
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://zenmux.ai/api/subscription/public/get_all_plans", nil)
	if err != nil {
		return nil, err
	}
	resp, err := f.Client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	var plansResp struct {
		Data []struct {
			Desc   string `json:"desc"`
			Models []struct {
				ProviderSlug string `json:"provider_slug"`
				ModelSlug    string `json:"model_slug"`
			} `json:"models"`
		} `json:"data"`
	}

	if err := json.Unmarshal(body, &plansResp); err != nil {
		return nil, err
	}

	planSlugs := map[string]struct{}{}
	for _, p := range plansResp.Data {
		if strings.Contains(p.Desc, "5 Flows/5h") {
			for _, m := range p.Models {
				if m.ProviderSlug == "*" {
					planSlugs[m.ModelSlug] = struct{}{}
				}
			}
		}
	}

	if len(planSlugs) == 0 {
		return nil, fmt.Errorf("no free models found in zenmux plans")
	}

	// 2. Fetch active models
	req2, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://zenmux.ai/api/v1/models", nil)
	if err != nil {
		return nil, err
	}
	resp2, err := f.Client.Do(req2)
	if err != nil {
		return nil, err
	}
	defer resp2.Body.Close()

	body2, err := io.ReadAll(resp2.Body)
	if err != nil {
		return nil, err
	}

	var modelsResp struct {
		Data []struct {
			ID               string   `json:"id"`
			OutputModalities []string `json:"output_modalities"`
		} `json:"data"`
	}

	if err := json.Unmarshal(body2, &modelsResp); err != nil {
		return nil, err
	}

	result := map[string]string{}
	for _, m := range modelsResp.Data {
		if _, ok := planSlugs[m.ID]; !ok {
			continue
		}
		modelID := strings.TrimSpace(m.ID)
		if modelID == "" {
			continue
		}
		key := sync.CleanKeyToModelKey(modelID)
		result[key] = modelID
	}

	return result, nil
}
