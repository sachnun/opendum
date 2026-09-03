package sync

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

type ProviderResult struct {
	Provider string
	Total    int
	Added    []string
	Removed  []string
	Updated  []string
}

type Provider interface {
	Name() string
	Sync(ctx context.Context, modelsDir string) (ProviderResult, error)
}

type providerFunc struct {
	name string
	fn   func(ctx context.Context, modelsDir string) (ProviderResult, error)
}

func (p providerFunc) Name() string { return p.name }

func (p providerFunc) Sync(ctx context.Context, modelsDir string) (ProviderResult, error) {
	return p.fn(ctx, modelsDir)
}

func FuncProvider(name string, fn func(ctx context.Context, modelsDir string) (ProviderResult, error)) Provider {
	return providerFunc{name: name, fn: fn}
}

type ModelDiff struct {
	Model    string
	Provider string
}

type DiffSummary struct {
	Added   []ModelDiff
	Removed []ModelDiff
}

func (s *DiffSummary) FormatMarkdown() string {
	if len(s.Added) == 0 && len(s.Removed) == 0 {
		return "_No model changes detected._\n"
	}
	var out string
	if len(s.Added) > 0 {
		sort.Slice(s.Added, func(i, j int) bool { return s.Added[i].Model < s.Added[j].Model })
		out += fmt.Sprintf("### Added Models (%d)\n\n", len(s.Added))
		for _, item := range s.Added {
			out += fmt.Sprintf("- `%s` *(%s)*\n", item.Model, item.Provider)
		}
		out += "\n"
	}
	if len(s.Removed) > 0 {
		sort.Slice(s.Removed, func(i, j int) bool { return s.Removed[i].Model < s.Removed[j].Model })
		out += fmt.Sprintf("### Removed Models (%d)\n\n", len(s.Removed))
		for _, item := range s.Removed {
			out += fmt.Sprintf("- `%s` *(%s)*\n", item.Model, item.Provider)
		}
		out += "\n"
	}
	return out
}

func SnapshotProviderModels(modelsDir string, providers []string) (map[string]map[string]bool, error) {
	index, err := BuildDiskIndex(modelsDir)
	if err != nil {
		return nil, err
	}
	snapshot := map[string]map[string]bool{}
	for _, p := range providers {
		snapshot[p] = map[string]bool{}
	}
	seen := map[*DiskModelEntry]bool{}
	for _, entry := range index {
		if seen[entry] {
			continue
		}
		seen[entry] = true
		publicID := entry.ID
		if publicID == "" {
			publicID = entry.FileID
		}
		for _, p := range GetStringSlice(entry.Data["providers"]) {
			if _, ok := snapshot[p]; ok {
				snapshot[p][publicID] = true
			}
		}
	}
	return snapshot, nil
}

func GenerateSummary(before, after map[string]map[string]bool, providers []string) *DiffSummary {
	summary := &DiffSummary{}
	for _, p := range providers {
		oldKeys := before[p]
		newKeys := after[p]
		for key := range newKeys {
			if !oldKeys[key] {
				summary.Added = append(summary.Added, ModelDiff{Model: key, Provider: p})
			}
		}
		for key := range oldKeys {
			if !newKeys[key] {
				summary.Removed = append(summary.Removed, ModelDiff{Model: key, Provider: p})
			}
		}
	}
	return summary
}

func providerNames(providers []Provider) []string {
	names := make([]string, 0, len(providers))
	for _, p := range providers {
		names = append(names, p.Name())
	}
	return names
}

func RunRefresh(ctx context.Context, modelsDir string, providers []Provider, summaryPath string) error {
	names := providerNames(providers)
	before, err := SnapshotProviderModels(modelsDir, names)
	if err != nil {
		return err
	}
	failures := []string{}
	for _, p := range providers {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}
		if _, err := p.Sync(ctx, modelsDir); err != nil {
			fmt.Printf("%v\n", err)
			failures = append(failures, p.Name())
		}
	}
	if len(failures) > 0 {
		return fmt.Errorf("refresh failed for: %s", joinStrings(failures, ", "))
	}
	after, err := SnapshotProviderModels(modelsDir, names)
	if err != nil {
		return err
	}
	if summaryPath != "" {
		summary := GenerateSummary(before, after, names).FormatMarkdown()
		if err := os.WriteFile(summaryPath, []byte(summary), 0644); err != nil {
			return err
		}
		fmt.Printf("PR summary written to %s\n", summaryPath)
	}
	return nil
}

func SyncDir(src, dest string) error {
	srcFiles, err := CollectModelFiles(src)
	if err != nil {
		return err
	}
	relSeen := map[string]bool{}
	for _, f := range srcFiles {
		rel, err := filepath.Rel(src, f)
		if err != nil {
			return err
		}
		relSeen[rel] = true
		destPath := filepath.Join(dest, rel)
		content, err := os.ReadFile(f)
		if err != nil {
			return err
		}
		existing, err := os.ReadFile(destPath)
		if err == nil && string(existing) == string(content) {
			continue
		}
		if err := os.MkdirAll(filepath.Dir(destPath), 0755); err != nil {
			return err
		}
		if err := os.WriteFile(destPath, content, 0644); err != nil {
			return err
		}
	}
	return removeStaleFiles(dest, dest, relSeen)
}

func removeStaleFiles(root, dir string, seen map[string]bool) error {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	for _, e := range entries {
		p := filepath.Join(dir, e.Name())
		if e.IsDir() {
			if err := removeStaleFiles(root, p, seen); err != nil {
				return err
			}
			continue
		}
		if !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		rel, err := filepath.Rel(root, p)
		if err != nil {
			return err
		}
		if !seen[rel] {
			if err := os.Remove(p); err != nil {
				return err
			}
		}
	}
	return nil
}

func joinStrings(s []string, sep string) string {
	out := ""
	for i, v := range s {
		if i > 0 {
			out += sep
		}
		out += v
	}
	return out
}
