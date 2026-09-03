package providers

import (
	"context"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	gosync "github.com/opendum/opendum/packages/ai/pkg/sync"
	"github.com/opendum/opendum/packages/ai/pkg/sync/httpfetch"
)

const codexModelsURL = "https://raw.githubusercontent.com/openai/codex/main/codex-rs/models-manager/models.json"

var codexCompatible = map[string]bool{
	"gpt-5.5": true, "gpt-5.4": true, "gpt-5.4-mini": true, "gpt-5.3-codex": true, "gpt-5.2": true,
}

type codexEntry struct {
	Slug                   string   `json:"slug"`
	Visibility             string   `json:"visibility"`
	SupportedInAPI         *bool    `json:"supported_in_api"`
	SupportedReasoningLvls []any    `json:"supported_reasoning_levels"`
	ShellType              string   `json:"shell_type"`
	InputModalities        []string `json:"input_modalities"`
}

func SyncCodex(ctx context.Context, modelsDir string) (gosync.ProviderResult, error) {
	client := &http.Client{Timeout: 20 * time.Second}
	var payload struct {
		Models []codexEntry `json:"models"`
	}
	if err := httpfetch.FetchJSON(ctx, client, codexModelsURL, &payload, &httpfetch.Options{Label: "Codex CLI model list"}); err != nil {
		return gosync.ProviderResult{Provider: "codex"}, err
	}
	lookup := map[string]codexEntry{}
	filtered := []codexEntry{}
	for _, m := range payload.Models {
		if m.Slug == "" {
			continue
		}
		lookup[m.Slug] = m
		if m.Visibility != "" && m.Visibility != "list" {
			continue
		}
		if m.SupportedInAPI != nil && !*m.SupportedInAPI {
			continue
		}
		if !codexCompatible[m.Slug] {
			continue
		}
		filtered = append(filtered, m)
	}
	modelMap := map[string]string{}
	for _, m := range filtered {
		modelMap[m.Slug] = m.Slug
	}
	if _, ok := modelMap["gpt-5.5"]; !ok {
		modelMap["gpt-5.5"] = "gpt-5.5"
	}
	modelMap = sortMap(modelMap)
	missing := []string{}
	for slug := range codexCompatible {
		if _, ok := lookup[slug]; !ok {
			missing = append(missing, slug)
		}
	}
	sort.Strings(missing)
	if len(missing) > 0 {
		fmt.Printf("[codex] Source feed is missing documented ChatGPT-compatible models: %s\n", strings.Join(missing, ", "))
	}
	res, err := gosync.SyncProviderRegistry(modelsDir, "codex", modelMap, nil, nil)
	if err != nil {
		return res, err
	}
	if len(res.Added) > 0 {
		idx, err := gosync.BuildDiskIndex(modelsDir)
		if err == nil {
			byFile := map[string]*gosync.DiskModelEntry{}
			for _, e := range idx {
				byFile[e.FileID] = e
				if e.ID != "" {
					byFile[e.ID] = e
				}
			}
			for _, key := range res.Added {
				e := byFile[key]
				if e == nil {
					continue
				}
				meta, ok := lookup[key]
				if !ok {
					continue
				}
				var dataMeta map[string]any
				if m, ok := e.Data["meta"].(map[string]any); ok {
					dataMeta = m
				} else {
					dataMeta = map[string]any{}
					e.Data["meta"] = dataMeta
				}
				if len(meta.SupportedReasoningLvls) > 0 {
					dataMeta["reasoning"] = true
				}
				if meta.ShellType != "" {
					dataMeta["toolCall"] = true
				}
				hasImage := false
				for _, m := range meta.InputModalities {
					if m == "image" {
						hasImage = true
						break
					}
				}
				dataMeta["vision"] = hasImage
				_ = gosync.WriteModelJSON(e.Path, e.Data)
			}
		}
	}
	if len(res.Added) == 0 && len(res.Removed) == 0 && len(res.Updated) == 0 {
		fmt.Printf("Codex CLI models are already up to date (%d models).\n", len(modelMap))
	} else {
		fmt.Printf("Codex ChatGPT-compatible models: %d models (added %d, removed %d, updated %d).\n", len(modelMap), len(res.Added), len(res.Removed), len(res.Updated))
	}
	return res, nil
}
