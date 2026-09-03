package providers

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"

	gosync "github.com/opendum/opendum/packages/ai/pkg/sync"
	"github.com/opendum/opendum/packages/ai/pkg/sync/httpfetch"
)

const kiloCodeModelsURL = "https://api.kilo.ai/api/gateway/models"

var kiloCodeKeyOverrides = map[string]string{
	"x-ai/grok-code-fast-1:optimized:free": "grok-code-fast-1",
}

func kiloCodeToModelKey(modelID string) string {
	if v, ok := kiloCodeKeyOverrides[modelID]; ok {
		return v
	}
	if strings.HasPrefix(modelID, "kilo-auto/") {
		return stripKey(strings.ReplaceAll(modelID, "/", "-"))
	}
	without := modelID
	if idx := strings.Index(modelID, "/"); idx != -1 {
		without = modelID[idx+1:]
	}
	key := sanitizeKey(strings.TrimSuffix(without, ":free"))
	return stripKey(key)
}

func SyncKiloCode(ctx context.Context, modelsDir string) (gosync.ProviderResult, error) {
	client := &http.Client{Timeout: 20 * time.Second}
	var payload struct {
		Data []struct {
			ID     string `json:"id"`
			IsFree bool   `json:"isFree"`
		} `json:"data"`
	}
	if err := httpfetch.FetchJSON(ctx, client, kiloCodeModelsURL, &payload, &httpfetch.Options{Label: "Kilo Gateway /models"}); err != nil {
		return gosync.ProviderResult{Provider: "kilo_code"}, err
	}
	ids := []string{}
	for _, m := range payload.Data {
		if !m.IsFree {
			continue
		}
		if id := strings.TrimSpace(m.ID); id != "" {
			ids = append(ids, id)
		}
	}
	modelMap := buildSuffixedMap(ids, kiloCodeToModelKey)
	res, err := gosync.SyncProviderRegistry(modelsDir, "kilo_code", modelMap, nil, nil)
	if err != nil {
		return res, err
	}
	metaUpdates := 0
	idx, err := gosync.BuildDiskIndex(modelsDir)
	if err == nil {
		seen := map[*gosync.DiskModelEntry]bool{}
		for _, entry := range idx {
			if seen[entry] {
				continue
			}
			seen[entry] = true
			has := false
			for _, p := range gosync.GetStringSlice(entry.Data["providers"]) {
				if p == "kilo_code" {
					has = true
					break
				}
			}
			if !has {
				continue
			}
			pcfg, ok := entry.Data["providerConfig"].(map[string]any)
			if !ok {
				continue
			}
			kilo, ok := pcfg["kilo_code"].(map[string]any)
			if !ok {
				continue
			}
			if kilo["authless"] != true {
				kilo["authless"] = true
				if err := gosync.WriteModelJSON(entry.Path, entry.Data); err == nil {
					metaUpdates++
				}
			}
		}
	}
	if len(res.Added) == 0 && len(res.Removed) == 0 && len(res.Updated) == 0 && metaUpdates == 0 {
		fmt.Printf("Kilo Code models are already up to date (%d models).\n", len(modelMap))
	} else {
		fmt.Printf("Kilo Code: %d free models (added %d, removed %d, updated %d, metadata %d).\n", len(modelMap), len(res.Added), len(res.Removed), len(res.Updated), metaUpdates)
	}
	return res, nil
}
