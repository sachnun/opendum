package providers

import (
	"context"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/opendum/opendum/packages/ai/pkg/sync"
	"github.com/opendum/opendum/packages/ai/pkg/sync/httpfetch"
)

const (
	zenMuxPlansURL  = "https://zenmux.ai/api/subscription/public/get_all_plans"
	zenMuxModelsURL = "https://zenmux.ai/api/v1/models"
)

func zenMuxToModelKey(modelID string) string {
	base := modelID
	if idx := strings.Index(modelID, "/"); idx != -1 {
		base = modelID[idx+1:]
	}
	cleaned := stripKey(sanitizeKey(base))
	return trimFreeSuffix(cleaned)
}

func SyncZenMux(ctx context.Context, modelsDir string) (sync.ProviderResult, error) {
	client := &http.Client{Timeout: 20 * time.Second}
	var plans struct {
		Data []struct {
			Desc   string `json:"desc"`
			Models []struct {
				ProviderSlug string `json:"provider_slug"`
				ModelSlug    string `json:"model_slug"`
			} `json:"models"`
		} `json:"data"`
	}
	if err := httpfetch.FetchJSON(ctx, client, zenMuxPlansURL, &plans, &httpfetch.Options{Label: "ZenMux subscription plans"}); err != nil {
		return sync.ProviderResult{Provider: "zenmux"}, err
	}
	planSlugs := map[string]bool{}
	for _, p := range plans.Data {
		if !strings.Contains(p.Desc, "5 Flows/5h") {
			continue
		}
		for _, m := range p.Models {
			if m.ProviderSlug == "*" {
				planSlugs[m.ModelSlug] = true
			}
		}
	}
	if len(planSlugs) == 0 {
		return sync.ProviderResult{Provider: "zenmux"}, fmt.Errorf("No models found in ZenMux Free Plan")
	}
	var all struct {
		Data []struct {
			ID               string   `json:"id"`
			OutputModalities []string `json:"output_modalities"`
		} `json:"data"`
	}
	if err := httpfetch.FetchJSON(ctx, client, zenMuxModelsURL, &all, &httpfetch.Options{Label: "ZenMux /v1/models"}); err != nil {
		return sync.ProviderResult{Provider: "zenmux"}, err
	}
	ids := []string{}
	seen := map[string]bool{}
	for _, m := range all.Data {
		if !planSlugs[m.ID] {
			continue
		}
		mods := m.OutputModalities
		if len(mods) > 0 && !containsStr(mods, "text") {
			continue
		}
		id := strings.TrimSpace(m.ID)
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		ids = append(ids, id)
	}
	sort.Strings(ids)
	modelMap := buildSuffixedMap(ids, zenMuxToModelKey)
	extra := map[string]map[string]any{}
	for id := range idsSet(ids) {
		_ = id
	}
	for k := range modelMap {
		extra[k] = map[string]any{}
	}
	res, err := sync.SyncProviderRegistry(modelsDir, "zenmux", modelMap, extra, nil)
	if err != nil {
		return res, err
	}
	if len(res.Added) == 0 && len(res.Removed) == 0 && len(res.Updated) == 0 {
		fmt.Printf("ZenMux free plan models are already up to date (%d models).\n", len(modelMap))
	} else {
		fmt.Printf("ZenMux: %d models (added %d, removed %d, updated %d).\n", len(modelMap), len(res.Added), len(res.Removed), len(res.Updated))
	}
	return res, nil
}

func idsSet(ids []string) map[string]bool {
	m := map[string]bool{}
	for _, id := range ids {
		m[id] = true
	}
	return m
}
