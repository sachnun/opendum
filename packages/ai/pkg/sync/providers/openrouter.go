package providers

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/opendum/opendum/packages/ai/pkg/sync"
	"github.com/opendum/opendum/packages/ai/pkg/sync/httpfetch"
)

const openRouterModelsURL = "https://openrouter.ai/api/v1/models"

var ignoredOpenRouterKeys = map[string]bool{"gpt-oss-120b": true}

func openRouterToModelKey(modelID string) string {
	normalized := strings.TrimPrefix(modelID, "library/")
	stripped := normalized
	if normalized != "openrouter/free" {
		if idx := strings.Index(normalized, "/"); idx != -1 {
			stripped = normalized[idx+1:]
		}
	}
	key := sanitizeKey(stripped)
	cleaned := stripKey(key)
	if key != "openrouter-free" && strings.HasSuffix(cleaned, "-free") {
		return cleaned[:len(cleaned)-len("-free")]
	}
	return cleaned
}

type openRouterModel struct {
	ID           string `json:"id"`
	Architecture *struct {
		InputModalities  []string `json:"input_modalities"`
		OutputModalities []string `json:"output_modalities"`
	} `json:"architecture"`
	SupportedParameters []string `json:"supported_parameters"`
}

func isOpenRouterFreeChat(m openRouterModel) bool {
	id := strings.TrimSpace(m.ID)
	if id == "" {
		return false
	}
	if id != "openrouter/free" && !strings.HasSuffix(id, ":free") {
		return false
	}
	inMods := []string{}
	outMods := []string{}
	if m.Architecture != nil {
		inMods = m.Architecture.InputModalities
		outMods = m.Architecture.OutputModalities
	}
	if len(inMods) > 0 && !containsStr(inMods, "text") {
		return false
	}
	if len(outMods) > 0 && !containsStr(outMods, "text") {
		return false
	}
	if len(m.SupportedParameters) > 0 &&
		!containsStr(m.SupportedParameters, "max_tokens") &&
		!containsStr(m.SupportedParameters, "temperature") &&
		!containsStr(m.SupportedParameters, "tools") {
		return false
	}
	return true
}

func containsStr(arr []string, s string) bool {
	for _, v := range arr {
		if v == s {
			return true
		}
	}
	return false
}

func SyncOpenRouter(ctx context.Context, modelsDir string) (sync.ProviderResult, error) {
	var payload struct {
		Data []openRouterModel `json:"data"`
	}
	client := &http.Client{Timeout: 20 * time.Second}
	if err := httpfetch.FetchJSON(ctx, client, openRouterModelsURL, &payload, &httpfetch.Options{Label: "OpenRouter /v1/models"}); err != nil {
		return sync.ProviderResult{Provider: "openrouter"}, err
	}
	seen := map[string]bool{}
	ids := []string{}
	for _, m := range payload.Data {
		if !isOpenRouterFreeChat(m) {
			continue
		}
		id := strings.TrimSpace(m.ID)
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		ids = append(ids, id)
	}
	sortStrings(ids)
	modelMap := map[string]string{}
	for _, id := range ids {
		base := openRouterToModelKey(id)
		if ignoredOpenRouterKeys[base] {
			continue
		}
		key := base
		suffix := 2
		for {
			existing, ok := modelMap[key]
			if !ok || existing == id {
				break
			}
			key = fmt.Sprintf("%s-%d", base, suffix)
			suffix++
		}
		modelMap[key] = id
	}
	modelMap = sortMap(modelMap)
	res, err := sync.SyncProviderRegistry(modelsDir, "openrouter", modelMap, nil, nil)
	if err != nil {
		return res, err
	}
	if len(res.Added) == 0 && len(res.Removed) == 0 && len(res.Updated) == 0 {
		fmt.Printf("OpenRouter free models are already up to date (%d models).\n", len(modelMap))
	} else {
		fmt.Printf("OpenRouter: %d models (added %d, removed %d, updated %d).\n", len(modelMap), len(res.Added), len(res.Removed), len(res.Updated))
	}
	return res, nil
}

func sortStrings(s []string) {
	for i := 1; i < len(s); i++ {
		for j := i; j > 0 && s[j] < s[j-1]; j-- {
			s[j], s[j-1] = s[j-1], s[j]
		}
	}
}
