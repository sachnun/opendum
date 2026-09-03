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

const nvidiaModelsURL = "https://integrate.api.nvidia.com/v1/models"

var nvidiaDocsURLs = []string{
	"https://docs.api.nvidia.com/nim/reference/llm-apis",
	"https://docs.api.nvidia.com/nim/reference/multimodal-apis",
	"https://docs.api.nvidia.com/nim/reference/visual-models-apis",
}

var nvidiaKeyOverrides = map[string]string{
	"baichuan-inc/baichuan2-13b-chat":   "baichuan2-13b-chat",
	"nvidia/nvidia-nemotron-nano-9b-v2": "nemotron-nano-9b-v2",
	"qwen/qwen2.5-coder-32b-instruct":   "qwen2.5-coder-32b",
	"qwen/qwen2.5-coder-7b-instruct":    "qwen2.5-coder-7b",
}

var nvidiaExcludedTokens = []string{
	"detection", "embed", "embedding", "guard", "nemoretriever",
	"parse", "rerank", "retriever", "safety", "vila",
}

func nvidiaToModelKey(modelID string) string {
	normalized := strings.TrimPrefix(modelID, "library/")
	if override, ok := nvidiaKeyOverrides[normalized]; ok {
		return override
	}
	base := normalized
	if idx := strings.Index(normalized, "/"); idx != -1 {
		base = normalized[idx+1:]
	}
	return stripKey(sanitizeKey(base))
}

func nvidiaNormalizeForMatch(modelID string) string {
	s := strings.TrimPrefix(modelID, "library/")
	s = strings.ToLower(s)
	re := regexp.MustCompile(`[^a-z0-9]+`)
	s = re.ReplaceAllString(s, "-")
	return strings.Trim(s, "-")
}

func nvidiaIsExcluded(modelID string) bool {
	norm := nvidiaNormalizeForMatch(modelID)
	for _, token := range nvidiaExcludedTokens {
		if strings.Contains(norm, token) {
			return true
		}
	}
	return false
}

func nvidiaStripHTML(s string) string {
	s = regexp.MustCompile(`<[^>]*>`).ReplaceAllString(s, "")
	s = strings.ReplaceAll(s, "&amp;", "&")
	s = strings.ReplaceAll(s, "&lt;", "<")
	s = strings.ReplaceAll(s, "&gt;", ">")
	s = strings.ReplaceAll(s, "&quot;", `"`)
	s = strings.ReplaceAll(s, "&#39;", "'")
	return strings.TrimSpace(regexp.MustCompile(`\s+`).ReplaceAllString(s, " "))
}

func nvidiaIsChatEndpoint(desc string) bool {
	norm := strings.ToLower(desc)
	for _, marker := range []string{
		"embedding", "classification", "classify", "detection", "generate dna",
		"generation", "ranking", "rerank", "retrieval", "search post", "status polling",
	} {
		if strings.Contains(norm, marker) {
			return false
		}
	}
	return strings.Contains(norm, "chat conversation") ||
		strings.Contains(norm, "chat completion") ||
		strings.Contains(norm, "create completion") ||
		strings.Contains(norm, "request response from the model")
}

func nvidiaGenerativeKeysFromHTML(html string) map[string]bool {
	keys := map[string]bool{}
	article := html
	if idx := strings.Index(html, `data-testid="RDMD"`); idx != -1 {
		rest := html[idx:]
		if end := strings.Index(rest, "</article>"); end != -1 {
			article = rest[:end]
		} else {
			article = rest
		}
	}
	rowRe := regexp.MustCompile(`(?s)<tr>(.*?)</tr>`)
	cellRe := regexp.MustCompile(`(?s)<td[^>]*>(.*?)</td>`)
	linkRe := regexp.MustCompile(`(?s)<a\b[^>]*>(.*?)</a>`)
	for _, row := range rowRe.FindAllStringSubmatch(article, -1) {
		cells := cellRe.FindAllStringSubmatch(row[1], -1)
		if len(cells) < 2 {
			continue
		}
		modelM := linkRe.FindStringSubmatch(cells[0][1])
		epM := linkRe.FindStringSubmatch(cells[1][1])
		if modelM == nil || epM == nil {
			continue
		}
		modelID := strings.ReplaceAll(nvidiaStripHTML(modelM[1]), " / ", "/")
		modelID = regexp.MustCompile(`\s*/\s*`).ReplaceAllString(modelID, "/")
		endpoint := nvidiaStripHTML(epM[1])
		if strings.Contains(modelID, "/") && !nvidiaIsExcluded(modelID) && nvidiaIsChatEndpoint(endpoint) {
			keys[nvidiaNormalizeForMatch(modelID)] = true
		}
	}
	return keys
}

func SyncNvidia(ctx context.Context, modelsDir string) (gosync.ProviderResult, error) {
	client := &http.Client{Timeout: 20 * time.Second}
	var modelIDs []string
	var llmKeys map[string]bool
	var wg sync.WaitGroup
	var idsErr, docsErr error
	wg.Add(2)
	go func() {
		defer wg.Done()
		var payload struct {
			Data []struct {
				ID string `json:"id"`
			} `json:"data"`
		}
		if err := httpfetch.FetchJSON(ctx, client, nvidiaModelsURL, &payload, &httpfetch.Options{Label: "Nvidia /v1/models"}); err != nil {
			idsErr = err
			return
		}
		for _, item := range payload.Data {
			if id := strings.TrimSpace(item.ID); id != "" {
				modelIDs = append(modelIDs, id)
			}
		}
	}()
	go func() {
		defer wg.Done()
		merged := map[string]bool{}
		type res struct {
			keys map[string]bool
			err  error
		}
		ch := make(chan res, len(nvidiaDocsURLs))
		var inner sync.WaitGroup
		for _, u := range nvidiaDocsURLs {
			inner.Add(1)
			go func(url string) {
				defer inner.Done()
				html, err := httpfetch.FetchText(ctx, client, url, &httpfetch.Options{Label: "Nvidia model docs", Headers: map[string]string{"Accept": "text/html"}})
				if err != nil {
					ch <- res{nil, err}
					return
				}
				ch <- res{nvidiaGenerativeKeysFromHTML(html), nil}
			}(u)
		}
		inner.Wait()
		close(ch)
		for r := range ch {
			if r.err != nil {
				docsErr = r.err
				return
			}
			for k := range r.keys {
				merged[k] = true
			}
		}
		if len(merged) == 0 {
			docsErr = fmt.Errorf("Unexpected Nvidia model docs payload format")
			return
		}
		llmKeys = merged
	}()
	wg.Wait()
	if idsErr != nil {
		return gosync.ProviderResult{Provider: "nvidia_nim"}, idsErr
	}
	if docsErr != nil {
		return gosync.ProviderResult{Provider: "nvidia_nim"}, docsErr
	}

	index, err := gosync.BuildDiskIndex(modelsDir)
	if err != nil {
		return gosync.ProviderResult{Provider: "nvidia_nim"}, err
	}
	existing := map[string]string{}
	for _, entry := range index {
		has := false
		for _, p := range gosync.GetStringSlice(entry.Data["providers"]) {
			if p == "nvidia_nim" {
				has = true
				break
			}
		}
		if !has {
			continue
		}
		up := gosync.GetProviderUpstream(entry.Data, "nvidia_nim", entry.FileID)
		key := entry.ID
		if key == "" {
			key = entry.FileID
		}
		existing[key] = up
	}

	uniq := map[string]bool{}
	for _, id := range modelIDs {
		uniq[id] = true
	}
	available := make([]string, 0, len(uniq))
	for id := range uniq {
		available = append(available, id)
	}
	sort.Strings(available)
	availableSet := map[string]bool{}
	byKey := map[string]string{}
	for _, id := range available {
		availableSet[id] = true
		k := nvidiaToModelKey(id)
		if _, ok := byKey[k]; !ok {
			byKey[k] = id
		}
	}
	availableLLM := map[string]bool{}
	for _, id := range available {
		if llmKeys[nvidiaNormalizeForMatch(id)] {
			availableLLM[id] = true
		}
	}
	next := map[string]string{}
	for k, up := range existing {
		resolved := ""
		if availableSet[up] {
			resolved = up
		} else if v, ok := byKey[k]; ok {
			resolved = v
		}
		if resolved == "" {
			continue
		}
		next[k] = resolved
	}
	mapped := map[string]bool{}
	for _, v := range next {
		mapped[v] = true
	}
	for _, up := range available {
		if mapped[up] || !availableLLM[up] {
			continue
		}
		base := nvidiaToModelKey(up)
		key := base
		suffix := 2
		for {
			existingUp, ok := next[key]
			if !ok || existingUp == up {
				break
			}
			key = fmt.Sprintf("%s-%d", base, suffix)
			suffix++
		}
		next[key] = up
		mapped[up] = true
	}
	sorted := sortMap(next)
	res, err := gosync.SyncProviderRegistry(modelsDir, "nvidia_nim", sorted, nil, nil)
	if err != nil {
		return res, err
	}
	if len(res.Added) == 0 && len(res.Removed) == 0 && len(res.Updated) == 0 {
		fmt.Printf("Nvidia NIM models are already up to date (%d models).\n", len(sorted))
	} else {
		fmt.Printf("Nvidia NIM: %d models (added %d, removed %d, updated %d).\n", len(sorted), len(res.Added), len(res.Removed), len(res.Updated))
	}
	return res, nil
}
