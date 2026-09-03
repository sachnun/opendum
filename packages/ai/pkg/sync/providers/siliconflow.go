package providers

import (
	"context"
	"fmt"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/opendum/opendum/packages/ai/pkg/sync"
	"github.com/opendum/opendum/packages/ai/pkg/sync/httpfetch"
)

const (
	siliconFlowModelsPage = "https://www.siliconflow.com/models"
	siliconFlowMinModels  = 20
)

var (
	siliconFlowIndexPattern = regexp.MustCompile(`<meta\s+name="framer-search-index(?:-fallback)?"\s+content="([^"]+)"`)
	siliconFlowCanonicalID  = regexp.MustCompile(`^[\w.-]+/[\w.-]+$`)
	siliconFlowExcluded     = []string{
		"embedding", "reranker", "rerank", "flux", "cosyvoice", "fish-speech",
		"indextts", "wan2", "z-image", "qwen-image", "stable-diffusion",
	}
)

func siliconFlowToModelKey(modelID string) string {
	base := modelID
	if idx := strings.Index(modelID, "/"); idx != -1 {
		base = modelID[idx+1:]
	}
	return stripKey(strings.ToLower(sanitizeKey(base)))
}

func siliconFlowIsChat(modelID string) bool {
	lower := strings.ToLower(modelID)
	for _, token := range siliconFlowExcluded {
		if strings.Contains(lower, token) {
			return false
		}
	}
	return true
}

func SyncSiliconFlow(ctx context.Context, modelsDir string) (sync.ProviderResult, error) {
	client := &http.Client{Timeout: 20 * time.Second}
	html, err := httpfetch.FetchText(ctx, client, siliconFlowModelsPage, &httpfetch.Options{Label: "SiliconFlow models page"})
	if err != nil {
		return sync.ProviderResult{Provider: "siliconflow"}, err
	}
	urls := []string{}
	seenURL := map[string]bool{}
	for _, m := range siliconFlowIndexPattern.FindAllStringSubmatch(html, -1) {
		if len(m) > 1 && m[1] != "" && !seenURL[m[1]] {
			seenURL[m[1]] = true
			urls = append(urls, m[1])
		}
	}
	if len(urls) == 0 {
		return sync.ProviderResult{Provider: "siliconflow"}, fmt.Errorf("Unable to locate framer-search-index URL on SiliconFlow models page")
	}
	var searchIndex map[string]struct {
		H2 []string `json:"h2"`
	}
	var fetchErr error
	for _, u := range urls {
		var idx map[string]struct {
			H2 []string `json:"h2"`
		}
		if err := httpfetch.FetchJSON(ctx, client, u, &idx, &httpfetch.Options{Label: "SiliconFlow search index"}); err != nil {
			fetchErr = err
			continue
		}
		searchIndex = idx
		fetchErr = nil
		break
	}
	if fetchErr != nil {
		return sync.ProviderResult{Provider: "siliconflow"}, fetchErr
	}
	if searchIndex == nil {
		return sync.ProviderResult{Provider: "siliconflow"}, fmt.Errorf("All SiliconFlow search index URLs failed")
	}
	idSet := map[string]bool{}
	for path, entry := range searchIndex {
		if !strings.HasPrefix(path, "/models/") || strings.Contains(path, "/compare/") {
			continue
		}
		for _, h := range entry.H2 {
			if siliconFlowCanonicalID.MatchString(strings.TrimSpace(h)) {
				idSet[strings.TrimSpace(h)] = true
			}
		}
	}
	ids := make([]string, 0, len(idSet))
	for id := range idSet {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	chatCount := 0
	for _, id := range ids {
		if siliconFlowIsChat(id) {
			chatCount++
		}
	}
	if chatCount < siliconFlowMinModels {
		return sync.ProviderResult{Provider: "siliconflow"}, fmt.Errorf("SiliconFlow search index returned only %d chat models (expected >= %d)", chatCount, siliconFlowMinModels)
	}
	filtered := []string{}
	for _, id := range ids {
		if siliconFlowIsChat(id) {
			filtered = append(filtered, id)
		}
	}
	modelMap := buildSuffixedMap(filtered, siliconFlowToModelKey)
	res, err := sync.SyncProviderRegistry(modelsDir, "siliconflow", modelMap, nil, nil)
	if err != nil {
		return res, err
	}
	if len(res.Added) == 0 && len(res.Removed) == 0 && len(res.Updated) == 0 {
		fmt.Printf("SiliconFlow models are already up to date (%d models).\n", len(modelMap))
	} else {
		fmt.Printf("SiliconFlow: %d models (added %d, removed %d, updated %d).\n", len(modelMap), len(res.Added), len(res.Removed), len(res.Updated))
	}
	return res, nil
}
