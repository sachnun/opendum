package sync

import (
	"context"
	"fmt"
	"sort"
	"sync"
	"time"

	"github.com/opendum/opendum/packages/ai/pkg/sync/cleankey"
)

type ProviderResult struct {
	Provider string
	Total    int
	Added    []string
	Removed  []string
	Updated  []string
	Error    error
}

type ProviderFetcher interface {
	Name() string
	Fetch(ctx context.Context) (map[string]string, error)
}

type DiffSummary struct {
	Added   []ModelDiff
	Removed []ModelDiff
}

type ModelDiff struct {
	Model    string
	Provider string
}

func (s *DiffSummary) FormatMarkdown() string {
	if len(s.Added) == 0 && len(s.Removed) == 0 {
		return "_No model changes detected._\n"
	}

	var out string
	if len(s.Added) > 0 {
		out += fmt.Sprintf("### Added Models (%d)\n\n", len(s.Added))
		sort.Slice(s.Added, func(i, j int) bool {
			return s.Added[i].Model < s.Added[j].Model
		})
		for _, item := range s.Added {
			out += fmt.Sprintf("- `%s` *(%s)*\n", item.Model, item.Provider)
		}
		out += "\n"
	}

	if len(s.Removed) > 0 {
		out += fmt.Sprintf("### Removed Models (%d)\n\n", len(s.Removed))
		sort.Slice(s.Removed, func(i, j int) bool {
			return s.Removed[i].Model < s.Removed[j].Model
		})
		for _, item := range s.Removed {
			out += fmt.Sprintf("- `%s` *(%s)*\n", item.Model, item.Provider)
		}
		out += "\n"
	}

	return out
}

type SyncManager struct {
	modelsDir string
	fetchers  []ProviderFetcher
}

func NewSyncManager(modelsDir string) *SyncManager {
	return &SyncManager{
		modelsDir: modelsDir,
		fetchers:  []ProviderFetcher{},
	}
}

func (m *SyncManager) Register(fetcher ProviderFetcher) {
	m.fetchers = append(m.fetchers, fetcher)
}

func (m *SyncManager) RunAll(ctx context.Context, concurrency int) ([]ProviderResult, *DiffSummary) {
	if concurrency <= 0 {
		concurrency = 4
	}

	sem := make(chan struct{}, concurrency)
	var wg sync.WaitGroup
	results := make([]ProviderResult, len(m.fetchers))

	for i, f := range m.fetchers {
		wg.Add(1)
		go func(idx int, fetcher ProviderFetcher) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			start := time.Now()
			modelMap, err := fetcher.Fetch(ctx)
			if err != nil {
				results[idx] = ProviderResult{
					Provider: fetcher.Name(),
					Error:    err,
				}
				fmt.Printf("[%s] Error: %v (took %v)\n", fetcher.Name(), err, time.Since(start))
				return
			}

			// Apply to model registry on disk
			res, syncErr := SyncProviderMap(m.modelsDir, fetcher.Name(), modelMap)
			if syncErr != nil {
				results[idx] = ProviderResult{
					Provider: fetcher.Name(),
					Error:    syncErr,
				}
				fmt.Printf("[%s] Sync error: %v\n", fetcher.Name(), syncErr)
				return
			}

			results[idx] = res
			fmt.Printf("[%s] Synced %d models (+%d, -%d, ~%d) in %v\n",
				fetcher.Name(), res.Total, len(res.Added), len(res.Removed), len(res.Updated), time.Since(start))
		}(i, f)
	}

	wg.Wait()

	summary := &DiffSummary{}
	for _, res := range results {
		for _, a := range res.Added {
			summary.Added = append(summary.Added, ModelDiff{Model: a, Provider: res.Provider})
		}
		for _, r := range res.Removed {
			summary.Removed = append(summary.Removed, ModelDiff{Model: r, Provider: res.Provider})
		}
	}

	return results, summary
}

// CleanKeyToModelKey standardizes a model ID to clean key format
func CleanKeyToModelKey(modelID string) string {
	slashIdx := 0
	for i, r := range modelID {
		if r == '/' {
			slashIdx = i + 1
		}
	}
	base := modelID[slashIdx:]
	var b []rune
	for _, r := range base {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '.' || r == '_' || r == '-' {
			b = append(b, r)
		} else {
			b = append(b, '-')
		}
	}
	raw := string(b)
	cleaned := cleankey.StripParamInfoKey(raw)
	if len(cleaned) > 5 && cleaned[len(cleaned)-5:] == "-free" {
		cleaned = cleaned[:len(cleaned)-5]
	}
	return cleaned
}
