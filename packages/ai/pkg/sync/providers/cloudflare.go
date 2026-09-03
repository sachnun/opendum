package providers

import (
	"context"
	"fmt"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	gosync "github.com/opendum/opendum/packages/ai/pkg/sync"
	"github.com/opendum/opendum/packages/ai/pkg/sync/httpfetch"
)

const (
	workersAIModelsAPI = "https://unroxy.koyeb.app/api.github.com/repos/cloudflare/cloudflare-docs/contents/src/content/workers-ai-models?ref=production"
	workersAIFetchConc = 8
)

var workersAIKeyOverrides = map[string]string{
	"@cf/meta/llama-3.1-8b-instruct-fast": "llama-3.1-8b-instruct",
	"@cf/qwen/qwen2.5-coder-32b-instruct": "qwen2.5-coder-32b",
}

var workersAIExcludedTokens = []string{"guard"}

func workersAINormalizeKey(value string) string {
	s := regexp.MustCompile(`^@[^/]+/`).ReplaceAllString(value, "")
	s = sanitizeKey(s)
	s = strings.Trim(s, "-")
	return stripKey(s)
}

func workersAIToModelKey(name, slug string, reverse map[string]string) string {
	upstream := strings.TrimSpace(name)
	if v, ok := workersAIKeyOverrides[upstream]; ok {
		return v
	}
	if v, ok := reverse[upstream]; ok {
		return v
	}
	if slug != "" {
		return workersAINormalizeKey(slug)
	}
	base := upstream
	if idx := strings.LastIndex(upstream, "/"); idx != -1 {
		base = upstream[idx+1:]
	}
	return workersAINormalizeKey(base)
}

func workersAIGetProp(model map[string]any, propID string) any {
	props, ok := model["properties"].([]any)
	if !ok {
		return nil
	}
	for _, p := range props {
		m, ok := p.(map[string]any)
		if !ok {
			continue
		}
		if m["property_id"] == propID {
			return m["value"]
		}
	}
	return nil
}

func workersAIIsTrue(v any) bool {
	return v == true || v == "true"
}

func workersAISupportsMessages(v any, depth int) bool {
	if depth > 64 || v == nil {
		return false
	}
	if arr, ok := v.([]any); ok {
		for _, item := range arr {
			if workersAISupportsMessages(item, depth+1) {
				return true
			}
		}
		return false
	}
	m, ok := v.(map[string]any)
	if !ok {
		return false
	}
	if props, ok := m["properties"].(map[string]any); ok {
		if _, ok := props["messages"]; ok {
			return true
		}
	}
	for _, item := range m {
		if workersAISupportsMessages(item, depth+1) {
			return true
		}
	}
	return false
}

func workersAIDeriveFamily(modelKey string) string {
	switch {
	case regexp.MustCompile(`(?i)^kimi-`).MatchString(modelKey):
		return "Moonshot"
	case regexp.MustCompile(`(?i)^glm-`).MatchString(modelKey):
		return "Z.AI"
	case regexp.MustCompile(`(?i)^gpt-|^o\d`).MatchString(modelKey):
		return "OpenAI"
	case regexp.MustCompile(`(?i)^gemma`).MatchString(modelKey):
		return "Gemini"
	case regexp.MustCompile(`(?i)^llama|^meta-llama`).MatchString(modelKey):
		return "Meta"
	case regexp.MustCompile(`(?i)^qwen|^qwq-`).MatchString(modelKey):
		return "Qwen"
	case regexp.MustCompile(`(?i)^deepseek-`).MatchString(modelKey):
		return "DeepSeek"
	case regexp.MustCompile(`(?i)^mistral-|^mixtral|^codestral|^devstral|^ministral|^mamba-codestral|^magistral`).MatchString(modelKey):
		return "Mistral"
	case regexp.MustCompile(`(?i)^nemotron-`).MatchString(modelKey):
		return "NVIDIA"
	case regexp.MustCompile(`(?i)^granite-`).MatchString(modelKey):
		return "IBM"
	case regexp.MustCompile(`(?i)^phi-`).MatchString(modelKey):
		return "Microsoft"
	}
	return ""
}

func SyncCloudflare(ctx context.Context, modelsDir string) (gosync.ProviderResult, error) {
	client := &http.Client{Timeout: 20 * time.Second}
	index, err := gosync.BuildDiskIndex(modelsDir)
	if err != nil {
		return gosync.ProviderResult{Provider: "workers_ai"}, err
	}
	reverse := map[string]string{}
	for _, entry := range index {
		has := false
		for _, p := range gosync.GetStringSlice(entry.Data["providers"]) {
			if p == "workers_ai" {
				has = true
				break
			}
		}
		if !has {
			continue
		}
		up := gosync.GetProviderUpstream(entry.Data, "workers_ai", entry.FileID)
		key := entry.ID
		if key == "" {
			key = entry.FileID
		}
		reverse[up] = key
	}
	var files []struct {
		Name        string `json:"name"`
		Type        string `json:"type"`
		DownloadURL string `json:"download_url"`
	}
	if err := httpfetch.FetchJSON(ctx, client, workersAIModelsAPI, &files, &httpfetch.Options{Label: "Cloudflare Workers AI model file list"}); err != nil {
		return gosync.ProviderResult{Provider: "workers_ai"}, err
	}
	type item struct {
		slug  string
		model map[string]any
	}
	tmp := []struct {
		Name        string
		DownloadURL string
	}{}
	for _, f := range files {
		if f.Type == "file" && strings.HasSuffix(f.Name, ".json") && f.DownloadURL != "" {
			tmp = append(tmp, struct {
				Name        string
				DownloadURL string
			}{f.Name, f.DownloadURL})
		}
	}
	sort.Slice(tmp, func(i, j int) bool { return tmp[i].Name < tmp[j].Name })
	results := make([]item, len(tmp))
	errs := make([]error, len(tmp))
	var nextIdx int
	var mu sync.Mutex
	var wg sync.WaitGroup
	worker := func() {
		defer wg.Done()
		for {
			mu.Lock()
			i := nextIdx
			nextIdx++
			mu.Unlock()
			if i >= len(tmp) {
				return
			}
			var model map[string]any
			if err := httpfetch.FetchJSON(ctx, client, tmp[i].DownloadURL, &model, &httpfetch.Options{Label: "Cloudflare model " + tmp[i].Name}); err != nil {
				errs[i] = err
				continue
			}
			results[i] = item{slug: strings.TrimSuffix(tmp[i].Name, ".json"), model: model}
		}
	}
	n := workersAIFetchConc
	if len(tmp) < n {
		n = len(tmp)
	}
	wg.Add(n)
	for i := 0; i < n; i++ {
		go worker()
	}
	wg.Wait()
	for _, e := range errs {
		if e != nil {
			return gosync.ProviderResult{Provider: "workers_ai"}, e
		}
	}
	modelMap := map[string]string{}
	metadata := map[string]struct {
		meta map[string]any
	}{}
	for _, it := range results {
		name, _ := it.model["name"].(string)
		task, _ := it.model["task"].(map[string]any)
		taskName, _ := task["name"].(string)
		key := workersAIToModelKey(name, it.slug, reverse)
		if key == "" || !workersAIShouldInclude(it.model, key, index, reverse) || taskName != "Text Generation" {
			_ = name
			continue
		}
		var schema map[string]any
		if s, ok := it.model["schema"].(map[string]any); ok {
			schema = s
		}
		if !workersAISupportsMessages(schema["input"], 0) {
			continue
		}
		modelMap[key] = strings.TrimSpace(name)
		metadata[key] = struct {
			meta map[string]any
		}{meta: map[string]any{
			"reasoning": workersAIIsTrue(workersAIGetProp(it.model, "reasoning")),
			"toolCall":  workersAIIsTrue(workersAIGetProp(it.model, "function_calling")),
			"vision":    workersAIIsTrue(workersAIGetProp(it.model, "vision")),
		}}
	}
	_ = metadata
	modelMap = sortMap(modelMap)
	res, err := gosync.SyncProviderRegistry(modelsDir, "workers_ai", modelMap, nil, nil)
	if err != nil {
		return res, err
	}
	metaUpdates := 0
	if len(metadata) > 0 {
		idx2, err := gosync.BuildDiskIndex(modelsDir)
		if err == nil {
			byFile := map[string]*gosync.DiskModelEntry{}
			for _, e := range idx2 {
				byFile[e.FileID] = e
				if e.ID != "" {
					byFile[e.ID] = e
				}
			}
			for key, info := range metadata {
				e := byFile[key]
				if e == nil {
					continue
				}
				var meta map[string]any
				if m, ok := e.Data["meta"].(map[string]any); ok {
					meta = m
				} else {
					meta = map[string]any{}
					e.Data["meta"] = meta
				}
				changed := false
				for k, v := range info.meta {
					if _, ok := meta[k]; !ok {
						meta[k] = v
						changed = true
					}
				}
				if !isEmptyMetaInit(meta) && changed {
					if err := gosync.WriteModelJSON(e.Path, e.Data); err == nil {
						metaUpdates++
					}
				} else if changed {
					if err := gosync.WriteModelJSON(e.Path, e.Data); err == nil {
						metaUpdates++
					}
				}
			}
		}
	}
	if len(res.Added) == 0 && len(res.Removed) == 0 && len(res.Updated) == 0 && metaUpdates == 0 {
		fmt.Printf("Cloudflare models are already up to date (%d models).\n", len(modelMap))
	} else {
		fmt.Printf("Cloudflare: %d models (added %d, removed %d, updated %d, metadata %d).\n", len(modelMap), len(res.Added), len(res.Removed), len(res.Updated), metaUpdates)
		if len(res.Added) > 0 {
			fmt.Printf("  Added: %s\n", strings.Join(sortedCopy(res.Added), ", "))
		}
		if len(res.Removed) > 0 {
			fmt.Printf("  Removed: %s\n", strings.Join(sortedCopy(res.Removed), ", "))
		}
		if len(res.Updated) > 0 {
			fmt.Printf("  Updated: %s\n", strings.Join(sortedCopy(res.Updated), ", "))
		}
	}
	return res, nil
}

func isEmptyMetaInit(meta map[string]any) bool { return false }

func workersAIShouldInclude(model map[string]any, modelKey string, index map[string]*gosync.DiskModelEntry, reverse map[string]string) bool {
	name, _ := model["name"].(string)
	if name == "" || !strings.HasPrefix(name, "@") {
		return false
	}
	if workersAIIsTrue(workersAIGetProp(model, "lora")) {
		return false
	}
	if dep := workersAIGetProp(model, "planned_deprecation_date"); dep != nil && dep != "" {
		if _, ok := reverse[name]; !ok {
			return false
		}
	}
	for _, e := range index {
		if (e.FileID == modelKey || e.ID == modelKey) && e.Data["ignored"] == true {
			has := false
			for _, p := range gosync.GetStringSlice(e.Data["providers"]) {
				if p == "workers_ai" {
					has = true
					break
				}
			}
			if !has {
				return false
			}
		}
	}
	lower := strings.ToLower(modelKey)
	for _, token := range workersAIExcludedTokens {
		if strings.Contains(lower, token) {
			return false
		}
	}
	return true
}

func sortedCopy(s []string) []string {
	out := append([]string{}, s...)
	sort.Strings(out)
	return out
}
