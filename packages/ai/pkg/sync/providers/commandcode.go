package providers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	gosync "github.com/opendum/opendum/packages/ai/pkg/sync"
	"github.com/opendum/opendum/packages/ai/pkg/sync/httpfetch"
)

const (
	commandCodeModelsAPI  = "https://api.commandcode.ai/provider/v1/models"
	commandCodePricingURL = "https://commandcode.ai/docs/resources/pricing-limits"
	commandCodeMinModels  = 15
)

func commandCodeToModelKey(modelID string) string {
	base := modelID
	if idx := strings.Index(modelID, "/"); idx != -1 {
		base = modelID[idx+1:]
	}
	return stripKey(strings.ToLower(sanitizeKey(base)))
}

func commandCodeOpenSourceNames(html string) (map[string]bool, error) {
	const prefix = `self.__next_f.push([1,"`
	searchFrom := 0
	for {
		start := strings.Index(html[searchFrom:], prefix)
		if start == -1 {
			break
		}
		start += searchFrom
		contentStart := start + len(prefix)
		var payload strings.Builder
		i := contentStart
		for i < len(html) {
			if html[i] == '\\' && i+1 < len(html) {
				payload.WriteByte(html[i])
				payload.WriteByte(html[i+1])
				i += 2
			} else if strings.HasPrefix(html[i:], `"])`) {
				break
			} else {
				payload.WriteByte(html[i])
				i++
			}
		}
		raw := payload.String()
		if strings.Contains(raw, "opensource") && strings.Contains(raw, "models") {
			unescaped := strings.ReplaceAll(raw, `\"`, `"`)
			bracket := strings.Index(unescaped, "[")
			if bracket == -1 {
				searchFrom = contentStart + payload.Len()
				continue
			}
			jsonStr := unescaped[bracket:]
			jsonStr = strings.TrimRight(jsonStr, "\n")
			jsonStr = regexpTrimTrailing(jsonStr)
			var data []any
			if err := json.Unmarshal([]byte(jsonStr), &data); err != nil {
				searchFrom = contentStart + payload.Len()
				continue
			}
			if len(data) > 3 {
				if obj, ok := data[3].(map[string]any); ok {
					if models, ok := obj["models"].([]any); ok {
						names := map[string]bool{}
						for _, m := range models {
							mm, ok := m.(map[string]any)
							if !ok {
								continue
							}
							if mm["category"] == "opensource" {
								if name, ok := mm["name"].(string); ok && name != "" {
									names[name] = true
								}
							}
						}
						return names, nil
					}
				}
			}
		}
		searchFrom = contentStart + payload.Len()
	}
	return nil, fmt.Errorf("Unable to locate open-source model data in Command Code pricing docs")
}

func regexpTrimTrailing(s string) string {
	i := len(s)
	for i > 0 && s[i-1] != '}' && s[i-1] != ']' {
		i--
	}
	return s[:i]
}

func SyncCommandCode(ctx context.Context, modelsDir string) (gosync.ProviderResult, error) {
	client := &http.Client{Timeout: 20 * time.Second}
	var apiPayload struct {
		Data []struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		} `json:"data"`
	}
	var docsHTML string
	var wg sync.WaitGroup
	var apiErr, docsErr error
	wg.Add(2)
	go func() {
		defer wg.Done()
		apiErr = httpfetch.FetchJSON(ctx, client, commandCodeModelsAPI, &apiPayload, &httpfetch.Options{Label: "Command Code /provider/v1/models"})
	}()
	go func() {
		defer wg.Done()
		docsHTML, docsErr = httpfetch.FetchText(ctx, client, commandCodePricingURL, &httpfetch.Options{Label: "Command Code pricing docs", Headers: map[string]string{"Accept": "text/html"}})
	}()
	wg.Wait()
	if apiErr != nil {
		return gosync.ProviderResult{Provider: "command_code"}, apiErr
	}
	if docsErr != nil {
		return gosync.ProviderResult{Provider: "command_code"}, docsErr
	}
	openSource, err := commandCodeOpenSourceNames(docsHTML)
	if err != nil {
		return gosync.ProviderResult{Provider: "command_code"}, err
	}
	if len(openSource) == 0 {
		return gosync.ProviderResult{Provider: "command_code"}, fmt.Errorf("No open-source models found in Command Code pricing docs")
	}
	type model struct{ id string }
	models := []model{}
	for _, item := range apiPayload.Data {
		id := strings.TrimSpace(item.ID)
		name := strings.TrimSpace(item.Name)
		if id == "" || name == "" {
			continue
		}
		if !openSource[name] {
			continue
		}
		models = append(models, model{id})
	}
	if len(models) < commandCodeMinModels {
		return gosync.ProviderResult{Provider: "command_code"}, fmt.Errorf("Command Code resolved only %d Go-tier models (expected >= %d)", len(models), commandCodeMinModels)
	}
	modelMap := map[string]string{}
	extra := map[string]map[string]any{}
	for _, m := range models {
		base := commandCodeToModelKey(m.id)
		key := base
		suffix := 2
		for {
			existing, ok := modelMap[key]
			if !ok || existing == m.id {
				break
			}
			key = fmt.Sprintf("%s-%d", base, suffix)
			suffix++
		}
		modelMap[key] = m.id
		extra[key] = map[string]any{"allowedTiers": []any{"go"}}
	}
	modelMap = sortMap(modelMap)
	res, err := gosync.SyncProviderRegistry(modelsDir, "command_code", modelMap, extra, []string{"allowedTiers"})
	if err != nil {
		return res, err
	}
	if len(res.Added) == 0 && len(res.Removed) == 0 && len(res.Updated) == 0 {
		fmt.Printf("Command Code Go-tier models are already up to date (%d models).\n", len(modelMap))
	} else {
		fmt.Printf("Command Code: %d models (added %d, removed %d, updated %d).\n", len(modelMap), len(res.Added), len(res.Removed), len(res.Updated))
	}
	return res, nil
}
