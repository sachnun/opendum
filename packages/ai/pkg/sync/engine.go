package sync

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/opendum/opendum/packages/ai/pkg/sync/cleankey"
)

type DiskModelEntry struct {
	Path     string
	FileID   string
	ID       string
	Data     map[string]any
	Folder   string
}

func BuildDiskIndex(modelsDir string) (map[string]*DiskModelEntry, error) {
	index := map[string]*DiskModelEntry{}

	err := filepath.WalkDir(modelsDir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || !strings.HasSuffix(d.Name(), ".json") {
			return nil
		}

		content, err := os.ReadFile(path)
		if err != nil {
			return err
		}

		var data map[string]any
		if err := json.Unmarshal(content, &data); err != nil {
			return fmt.Errorf("failed to parse %s: %w", path, err)
		}

		fileID := strings.TrimSuffix(filepath.Base(path), ".json")
		id, _ := data["id"].(string)
		if id == "" {
			id = fileID
		}

		rel, _ := filepath.Rel(modelsDir, path)
		folder := filepath.Dir(rel)
		if folder == "." {
			folder = ""
		}

		entry := &DiskModelEntry{
			Path:   path,
			FileID: fileID,
			ID:     id,
			Data:   data,
			Folder: folder,
		}

		index[fileID] = entry
		if id != fileID {
			index[id] = entry
		}
		return nil
	})

	return index, err
}

func SyncProviderMap(modelsDir, providerName string, modelMap map[string]string) (ProviderResult, error) {
	index, err := BuildDiskIndex(modelsDir)
	if err != nil {
		return ProviderResult{}, err
	}

	result := ProviderResult{
		Provider: providerName,
		Total:    len(modelMap),
		Added:    []string{},
		Removed:  []string{},
		Updated:  []string{},
	}

	// 1. Check existing entries for removal
	for _, entry := range index {
		providers := getStringSlice(entry.Data["providers"])
		hasProvider := false
		for _, p := range providers {
			if p == providerName {
				hasProvider = true
				break
			}
		}

		if !hasProvider {
			continue
		}

		// Check if entry matches any model in modelMap
		matched := false
		if _, ok := modelMap[entry.FileID]; ok {
			matched = true
		} else if _, ok := modelMap[entry.ID]; ok {
			matched = true
		} else {
			upstream := getEntryUpstream(entry.Data, providerName)
			for _, mapUpstream := range modelMap {
				if upstream == mapUpstream {
					matched = true
					break
				}
			}
		}

		if !matched {
			// Remove provider from this model
			newProviders := []string{}
			for _, p := range providers {
				if p != providerName {
					newProviders = append(newProviders, p)
				}
			}
			entry.Data["providers"] = newProviders

			// Clean providerConfig
			if pcfg, ok := entry.Data["providerConfig"].(map[string]any); ok {
				delete(pcfg, providerName)
				if len(pcfg) == 0 {
					delete(entry.Data, "providerConfig")
				}
			}

			if err := WriteFormattedJSON(entry.Path, entry.Data); err != nil {
				return result, err
			}
			result.Removed = append(result.Removed, entry.ID)
		}
	}

	// 2. Add or update models
	for modelKey, upstreamName := range modelMap {
		entry := findEntry(index, modelKey, upstreamName, providerName)
		if entry == nil {
			// Create new model file
			filePath := filepath.Join(modelsDir, fmt.Sprintf("%s.json", modelKey))
			newData := map[string]any{
				"providers": []string{providerName},
			}
			aliases := cleankey.AliasesFromUpstream([]string{upstreamName})
			if len(aliases) > 0 {
				newData["aliases"] = aliases
			}
			newData["providerConfig"] = map[string]any{
				providerName: map[string]any{
					"upstream": upstreamName,
				},
			}

			if err := WriteFormattedJSON(filePath, newData); err != nil {
				return result, err
			}
			result.Added = append(result.Added, modelKey)
		} else {
			// Update existing
			changed := false
			providers := getStringSlice(entry.Data["providers"])
			found := false
			for _, p := range providers {
				if p == providerName {
					found = true
					break
				}
			}
			if !found {
				providers = append(providers, providerName)
				sort.Strings(providers)
				entry.Data["providers"] = providers
				changed = true
				result.Added = append(result.Added, entry.ID)
			}

			// Ensure provider config
			pcfg, _ := entry.Data["providerConfig"].(map[string]any)
			if pcfg == nil {
				pcfg = map[string]any{}
				entry.Data["providerConfig"] = pcfg
			}

			provSettings, _ := pcfg[providerName].(map[string]any)
			if provSettings == nil {
				provSettings = map[string]any{}
				pcfg[providerName] = provSettings
			}

			if provSettings["upstream"] != upstreamName {
				provSettings["upstream"] = upstreamName
				changed = true
			}

			if changed {
				if err := WriteFormattedJSON(entry.Path, entry.Data); err != nil {
					return result, err
				}
				result.Updated = append(result.Updated, entry.ID)
			}
		}
	}

	return result, nil
}

func findEntry(index map[string]*DiskModelEntry, modelKey, upstreamName, providerName string) *DiskModelEntry {
	if entry, ok := index[modelKey]; ok {
		return entry
	}
	for _, entry := range index {
		if entry.ID == modelKey {
			return entry
		}
		for _, alias := range getStringSlice(entry.Data["aliases"]) {
			if alias == modelKey || alias == upstreamName {
				return entry
			}
		}
		if getEntryUpstream(entry.Data, providerName) == upstreamName {
			return entry
		}
	}
	return nil
}

func getEntryUpstream(data map[string]any, provider string) string {
	if pcfg, ok := data["providerConfig"].(map[string]any); ok {
		if prov, ok := pcfg[provider].(map[string]any); ok {
			if up, ok := prov["upstream"].(string); ok {
				return up
			}
		}
	}
	return ""
}

func getStringSlice(v any) []string {
	if v == nil {
		return nil
	}
	if arr, ok := v.([]string); ok {
		return arr
	}
	if arr, ok := v.([]any); ok {
		out := make([]string, 0, len(arr))
		for _, item := range arr {
			if s, ok := item.(string); ok && s != "" {
				out = append(out, s)
			}
		}
		return out
	}
	return nil
}

// WriteFormattedJSON marshals JSON with 2-space indentation and newline
func WriteFormattedJSON(filePath string, data map[string]any) error {
	dir := filepath.Dir(filePath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}

	buf := &bytes.Buffer{}
	enc := json.NewEncoder(buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(data); err != nil {
		return err
	}

	return os.WriteFile(filePath, buf.Bytes(), 0644)
}
