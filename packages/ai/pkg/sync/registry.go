package sync

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strings"

	"github.com/opendum/opendum/packages/ai/pkg/sync/cleankey"
)

var (
	modelPropOrder = []string{"id", "providers", "aliases", "description", "ignored", "meta", "providerConfig"}
	metaPropOrder  = []string{"reasoning", "toolCall", "vision", "type", "code", "tier", "variant", "status"}
	pcfgPropOrder  = []string{"upstream", "authless", "minTier", "allowedTiers", "aliases"}

	familyRules = []struct {
		pattern *regexp.Regexp
		folder  string
	}{
		{regexp.MustCompile(`^claude-`), "anthropic"},
		{regexp.MustCompile(`^gpt($|-)|^chatgpt-|^o($|-)|^o\d`), "openai"},
		{regexp.MustCompile(`^gemini-?|^gemma|^diffusiongemma`), "google"},
		{regexp.MustCompile(`^grok-?`), "xai"},
		{regexp.MustCompile(`^llama|^codellama`), "meta"},
		{regexp.MustCompile(`^phi-?`), "microsoft"},
		{regexp.MustCompile(`^qwen|^qwq-`), "qwen"},
		{regexp.MustCompile(`^deepseek-?`), "deepseek"},
		{regexp.MustCompile(`^kilo-auto-?`), "kilo-code"},
		{regexp.MustCompile(`^kimi-?`), "moonshot"},
		{regexp.MustCompile(`^minimax-?`), "minimax"},
		{regexp.MustCompile(`^glm-?`), "z-ai"},
		{regexp.MustCompile(`^mistral-|^codestral|^devstral|^ministral|^mamba-codestral|^magistral|^mixtral`), "mistral"},
		{regexp.MustCompile(`^nemotron-|^nim-?`), "nvidia"},
		{regexp.MustCompile(`^openrouter-?`), "openrouter"},
		{regexp.MustCompile(`^mimo-?`), "xiaomi"},
		{regexp.MustCompile(`^hunyuan|^hy3`), "hunyuan"},
		{regexp.MustCompile(`^ling-|^ring-|^ling`), "inclusion-ai"},
		{regexp.MustCompile(`^mai-code`), "microsoft"},
		{regexp.MustCompile(`^nex-n|^nex-n2`), "nex-agi"},
		{regexp.MustCompile(`^north-`), "cohere"},
	}
)

type DiskModelEntry struct {
	Path   string
	FileID string
	ID     string
	Data   map[string]any
}

func InferModelFolder(modelKey string) string {
	lower := strings.ToLower(modelKey)
	for _, rule := range familyRules {
		if rule.pattern.MatchString(lower) {
			return rule.folder
		}
	}
	return ""
}

func OrderProviders(providers []string) []string {
	sorted := make([]string, len(providers))
	copy(sorted, providers)
	sort.Slice(sorted, func(i, j int) bool {
		aFirst := 0
		if sorted[i] != "opencode" {
			aFirst = 1
		}
		bFirst := 0
		if sorted[j] != "opencode" {
			bFirst = 1
		}
		if aFirst != bFirst {
			return aFirst < bFirst
		}
		return sorted[i] < sorted[j]
	})
	return sorted
}

func isPlainObject(v any) bool {
	_, ok := v.(map[string]any)
	return ok
}

func orderValue(value any, key string) any {
	if key == "providers" {
		if arr, ok := value.([]any); ok {
			strs := make([]string, 0, len(arr))
			for _, item := range arr {
				if s, ok := item.(string); ok {
					strs = append(strs, s)
				}
			}
			out := make([]any, 0, len(strs))
			for _, s := range OrderProviders(strs) {
				out = append(out, s)
			}
			return out
		}
		if arr, ok := value.([]string); ok {
			out := make([]any, 0, len(arr))
			for _, s := range OrderProviders(arr) {
				out = append(out, s)
			}
			return out
		}
		return value
	}
	if arr, ok := value.([]any); ok {
		out := make([]any, len(arr))
		for i, item := range arr {
			out[i] = orderValue(item, "")
		}
		return out
	}
	if !isPlainObject(value) {
		return value
	}
	m := value.(map[string]any)
	if key == "meta" {
		return orderObject(m, metaPropOrder)
	}
	if key == "providerConfig" {
		return orderProviderMap(m, pcfgPropOrder)
	}
	return orderObject(m, nil)
}

func orderObject(value map[string]any, preferred []string) map[string]any {
	result := map[string]any{}
	pref := map[string]bool{}
	for _, k := range preferred {
		if v, ok := value[k]; ok {
			result[k] = orderValue(v, k)
			pref[k] = true
		}
	}
	rest := make([]string, 0, len(value))
	for k := range value {
		if !pref[k] {
			rest = append(rest, k)
		}
	}
	sort.Strings(rest)
	for _, k := range rest {
		result[k] = orderValue(value[k], k)
	}
	return result
}

func orderProviderMap(value map[string]any, preferred []string) map[string]any {
	result := map[string]any{}
	providers := make([]string, 0, len(value))
	for p := range value {
		providers = append(providers, p)
	}
	sort.Strings(providers)
	for _, p := range providers {
		if isPlainObject(value[p]) {
			result[p] = orderObject(value[p].(map[string]any), preferred)
		} else {
			result[p] = orderValue(value[p], p)
		}
	}
	return result
}

func normalizeModelData(data map[string]any) map[string]any {
	delete(data, "family")
	return orderObject(data, modelPropOrder)
}

func orderedKeys(data map[string]any, preferred []string) []string {
	keys := make([]string, 0, len(data))
	seen := map[string]bool{}
	for _, k := range preferred {
		if _, ok := data[k]; ok {
			keys = append(keys, k)
			seen[k] = true
		}
	}
	rest := make([]string, 0)
	for k := range data {
		if !seen[k] {
			rest = append(rest, k)
		}
	}
	sort.Strings(rest)
	return append(keys, rest...)
}

func marshalNoEscape(v any) ([]byte, error) {
	buf := &bytes.Buffer{}
	enc := json.NewEncoder(buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}

func writeOrderedValue(buf *bytes.Buffer, key string, val any, indent string) error {
	switch key {
	case "meta":
		if m, ok := val.(map[string]any); ok {
			return writeOrderedMap(buf, m, metaPropOrder, indent)
		}
	case "providerConfig":
		if m, ok := val.(map[string]any); ok {
			return writeProviderMap(buf, m, indent)
		}
	}
	return writeGenericValue(buf, val, indent)
}

func writeGenericValue(buf *bytes.Buffer, val any, indent string) error {
	raw, err := marshalNoEscape(val)
	if err != nil {
		return err
	}
	var out bytes.Buffer
	if err := json.Indent(&out, raw, indent, "  "); err != nil {
		trimmed := bytes.TrimSpace(raw)
		buf.Write(trimmed)
		return nil
	}
	buf.Write(bytes.TrimSpace(out.Bytes()))
	return nil
}

func writeOrderedMap(buf *bytes.Buffer, data map[string]any, preferred []string, indent string) error {
	if len(data) == 0 {
		buf.WriteString("{}")
		return nil
	}
	sub := indent + "  "
	buf.WriteString("{\n")
	keys := orderedKeys(data, preferred)
	for i, k := range keys {
		kb, _ := marshalNoEscape(k)
		buf.WriteString(sub + string(kb) + ": ")
		if isPlainObject(data[k]) {
			if err := writeOrderedMap(buf, data[k].(map[string]any), nil, sub); err != nil {
				return err
			}
		} else if err := writeGenericValue(buf, orderValue(data[k], k), sub); err != nil {
			return err
		}
		if i < len(keys)-1 {
			buf.WriteString(",")
		}
		buf.WriteString("\n")
	}
	buf.WriteString(indent + "}")
	return nil
}

func writeProviderMap(buf *bytes.Buffer, data map[string]any, indent string) error {
	if len(data) == 0 {
		buf.WriteString("{}")
		return nil
	}
	sub := indent + "  "
	buf.WriteString("{\n")
	providers := make([]string, 0, len(data))
	for p := range data {
		providers = append(providers, p)
	}
	sort.Strings(providers)
	for i, p := range providers {
		pb, _ := marshalNoEscape(p)
		buf.WriteString(sub + string(pb) + ": ")
		if isPlainObject(data[p]) {
			if err := writeOrderedMap(buf, data[p].(map[string]any), pcfgPropOrder, sub); err != nil {
				return err
			}
		} else if err := writeGenericValue(buf, orderValue(data[p], p), sub); err != nil {
			return err
		}
		if i < len(providers)-1 {
			buf.WriteString(",")
		}
		buf.WriteString("\n")
	}
	buf.WriteString(indent + "}")
	return nil
}

func OrderedJSON(data map[string]any) ([]byte, error) {
	normalized := normalizeModelData(data)
	buf := &bytes.Buffer{}
	buf.WriteString("{\n")
	keys := orderedKeys(normalized, modelPropOrder)
	for i, k := range keys {
		kb, _ := marshalNoEscape(k)
		buf.WriteString("  " + string(kb) + ": ")
		if err := writeOrderedValue(buf, k, normalized[k], "  "); err != nil {
			return nil, err
		}
		if i < len(keys)-1 {
			buf.WriteString(",")
		}
		buf.WriteString("\n")
	}
	buf.WriteString("}\n")
	return buf.Bytes(), nil
}

func WriteModelJSON(filePath string, data map[string]any) error {
	content, err := OrderedJSON(data)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(filePath), 0755); err != nil {
		return err
	}
	return os.WriteFile(filePath, content, 0644)
}

func CollectModelFiles(modelsDir string) ([]string, error) {
	entries, err := os.ReadDir(modelsDir)
	if err != nil {
		return nil, err
	}
	files := []string{}
	for _, entry := range entries {
		fullPath := filepath.Join(modelsDir, entry.Name())
		if entry.IsDir() {
			sub, err := os.ReadDir(fullPath)
			if err != nil {
				return nil, err
			}
			for _, f := range sub {
				if !f.IsDir() && strings.HasSuffix(f.Name(), ".json") {
					files = append(files, filepath.Join(fullPath, f.Name()))
				}
			}
		} else if strings.HasSuffix(entry.Name(), ".json") {
			files = append(files, fullPath)
		}
	}
	sort.Strings(files)
	return files, nil
}

func getModelPublicID(data map[string]any, fileID string) string {
	if id, ok := data["id"].(string); ok && strings.TrimSpace(id) != "" {
		return strings.TrimSpace(id)
	}
	return fileID
}

func BuildDiskIndex(modelsDir string) (map[string]*DiskModelEntry, error) {
	files, err := CollectModelFiles(modelsDir)
	if err != nil {
		return nil, err
	}
	index := map[string]*DiskModelEntry{}
	for _, filePath := range files {
		content, err := os.ReadFile(filePath)
		if err != nil {
			return nil, err
		}
		var data map[string]any
		if err := json.Unmarshal(content, &data); err != nil {
			return nil, err
		}
		fileID := strings.TrimSuffix(filepath.Base(filePath), ".json")
		index[fileID] = &DiskModelEntry{
			Path:   filePath,
			FileID: fileID,
			ID:     getModelPublicID(data, fileID),
			Data:   data,
		}
	}
	return index, nil
}

func GetProviderUpstream(data map[string]any, providerName, modelID string) string {
	if pcfg, ok := data["providerConfig"].(map[string]any); ok {
		if prov, ok := pcfg[providerName].(map[string]any); ok {
			if up, ok := prov["upstream"].(string); ok && strings.TrimSpace(up) != "" {
				return strings.TrimSpace(up)
			}
		}
	}
	return modelID
}

func GetStringSlice(v any) []string {
	if v == nil {
		return nil
	}
	if arr, ok := v.([]string); ok {
		out := make([]string, 0, len(arr))
		for _, s := range arr {
			if strings.TrimSpace(s) != "" {
				out = append(out, s)
			}
		}
		return out
	}
	if arr, ok := v.([]any); ok {
		out := make([]string, 0, len(arr))
		for _, item := range arr {
			if s, ok := item.(string); ok && strings.TrimSpace(s) != "" {
				out = append(out, s)
			}
		}
		return out
	}
	return nil
}

func canonicalJSON(v any) []byte {
	if v == nil {
		return []byte("null")
	}
	b, err := marshalNoEscape(normalizeForCompare(v))
	if err != nil {
		return []byte{}
	}
	return b
}

func normalizeForCompare(v any) any {
	switch t := v.(type) {
	case map[string]any:
		out := map[string]any{}
		for k, val := range t {
			out[k] = normalizeForCompare(val)
		}
		return out
	case []any:
		out := make([]any, len(t))
		for i, val := range t {
			out[i] = normalizeForCompare(val)
		}
		return out
	case []string:
		out := make([]any, len(t))
		for i, val := range t {
			out[i] = val
		}
		return out
	default:
		return v
	}
}

func jsonEqual(a, b any) bool {
	return bytes.Equal(canonicalJSON(a), canonicalJSON(b))
}

func findParentForCollision(index map[string]*DiskModelEntry, modelKey, upstreamName, provider string) (string, *DiskModelEntry) {
	entries := make([]*DiskModelEntry, 0, len(index))
	seen := map[*DiskModelEntry]bool{}
	for _, e := range index {
		if !seen[e] {
			seen[e] = true
			entries = append(entries, e)
		}
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].FileID < entries[j].FileID })
	if _, ok := index[modelKey]; ok {
		return "", nil
	}
	suffixRe := regexp.MustCompile(`^(.+?)(?:-(\d+)|-v(\d+(?:\.\d+)*))$`)
	if m := suffixRe.FindStringSubmatch(modelKey); m != nil {
		base, numericSuffix, versionSuffix := m[1], m[2], m[3]
		meaningful := (numericSuffix != "" && parseInt(numericSuffix) >= 2) || versionSuffix != ""
		if meaningful {
			var parent *DiskModelEntry
			if e, ok := index[base]; ok {
				parent = e
			} else {
				for _, e := range entries {
					if e.ID == base {
						parent = e
						break
					}
				}
				if parent == nil {
					for _, e := range entries {
						if e.FileID == modelKey {
							continue
						}
						for _, a := range GetStringSlice(e.Data["aliases"]) {
							if a == base {
								parent = e
								break
							}
						}
						if parent != nil {
							break
						}
					}
				}
			}
			if parent != nil {
				return base, parent
			}
		}
	}
	for _, e := range entries {
		if e.FileID == modelKey {
			continue
		}
		for _, a := range GetStringSlice(e.Data["aliases"]) {
			if a == upstreamName {
				return e.FileID, e
			}
		}
	}
	for _, e := range entries {
		if e.FileID == modelKey {
			continue
		}
		if GetProviderUpstream(e.Data, provider, e.FileID) == upstreamName {
			return e.FileID, e
		}
	}
	return "", nil
}

func parseInt(s string) int {
	n := 0
	for _, r := range s {
		if r < '0' || r > '9' {
			return n
		}
		n = n*10 + int(r-'0')
	}
	return n
}

func entryMatchesProviderMap(entry *DiskModelEntry, modelMap map[string]string, modelUpstreams map[string]struct{}, provider string) bool {
	if _, ok := modelMap[entry.FileID]; ok {
		return true
	}
	if _, ok := modelMap[entry.ID]; ok {
		return true
	}
	if up := GetProviderUpstream(entry.Data, provider, entry.ID); up != "" {
		if _, ok := modelUpstreams[up]; ok {
			return true
		}
	}
	for _, alias := range GetStringSlice(entry.Data["aliases"]) {
		if _, ok := modelMap[alias]; ok {
			return true
		}
		if _, ok := modelUpstreams[alias]; ok {
			return true
		}
	}
	return false
}

func findExistingEntry(index map[string]*DiskModelEntry, modelKey, upstreamName, provider string) *DiskModelEntry {
	if e, ok := index[modelKey]; ok {
		return e
	}
	entries := make([]*DiskModelEntry, 0, len(index))
	seen := map[*DiskModelEntry]bool{}
	for _, e := range index {
		if !seen[e] {
			seen[e] = true
			entries = append(entries, e)
		}
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].FileID < entries[j].FileID })
	for _, e := range entries {
		if e.ID == modelKey {
			return e
		}
	}
	for _, e := range entries {
		for _, a := range GetStringSlice(e.Data["aliases"]) {
			if a == modelKey {
				return e
			}
		}
	}
	for _, e := range entries {
		if GetProviderUpstream(e.Data, provider, e.FileID) == upstreamName {
			return e
		}
	}
	return nil
}

func SyncProviderRegistry(modelsDir, provider string, modelMap map[string]string, extraConfig map[string]map[string]any, managedKeys []string) (ProviderResult, error) {
	result := ProviderResult{Provider: provider, Total: len(modelMap), Added: []string{}, Removed: []string{}, Updated: []string{}}
	index, err := BuildDiskIndex(modelsDir)
	if err != nil {
		return result, err
	}
	extraFor := func(modelKey string) map[string]any {
		if extraConfig != nil && extraConfig[modelKey] != nil {
			return extraConfig[modelKey]
		}
		return map[string]any{}
	}
	modelUpstreams := map[string]struct{}{}
	for _, up := range modelMap {
		modelUpstreams[up] = struct{}{}
	}

	for modelKey, upstreamName := range modelMap {
		baseKey, parent := findParentForCollision(index, modelKey, upstreamName, provider)
		if parent == nil {
			continue
		}
		existing := map[string]bool{}
		for _, a := range GetStringSlice(parent.Data["aliases"]) {
			existing[a] = true
		}
		changed := false
		for _, alias := range cleankey.AliasesFromUpstream([]string{upstreamName}) {
			if !existing[alias] {
				existing[alias] = true
				changed = true
			}
		}
		if changed {
			aliases := make([]string, 0, len(existing))
			for a := range existing {
				aliases = append(aliases, a)
			}
			sort.Strings(aliases)
			parent.Data["aliases"] = aliases
			if err := WriteModelJSON(parent.Path, parent.Data); err != nil {
				return result, err
			}
			result.Updated = append(result.Updated, baseKey)
		}
		delete(modelMap, modelKey)
	}

	applyManaged := func(providerConfig map[string]any, modelKey string) bool {
		changed := false
		extra := extraFor(modelKey)
		var keys []string
		if managedKeys != nil {
			keys = managedKeys
		} else {
			for k := range extra {
				keys = append(keys, k)
			}
		}
		for _, k := range keys {
			next, ok := extra[k]
			if !ok {
				if _, has := providerConfig[k]; has {
					delete(providerConfig, k)
					changed = true
				}
				continue
			}
			if !jsonEqual(providerConfig[k], next) {
				providerConfig[k] = next
				changed = true
			}
		}
		return changed
	}

	for modelID, entry := range index {
		providers := GetStringSlice(entry.Data["providers"])
		has := false
		for _, p := range providers {
			if p == provider {
				has = true
				break
			}
		}
		if !has {
			continue
		}
		if entryMatchesProviderMap(entry, modelMap, modelUpstreams, provider) {
			continue
		}
		next := make([]string, 0, len(providers))
		for _, p := range providers {
			if p != provider {
				next = append(next, p)
			}
		}
		entry.Data["providers"] = next
		if pcfg, ok := entry.Data["providerConfig"].(map[string]any); ok {
			delete(pcfg, provider)
			if len(pcfg) == 0 {
				delete(entry.Data, "providerConfig")
			}
		}
		if err := WriteModelJSON(entry.Path, entry.Data); err != nil {
			return result, err
		}
		result.Removed = append(result.Removed, modelID)
	}

	for modelKey, upstreamName := range modelMap {
		existing := findExistingEntry(index, modelKey, upstreamName, provider)
		if existing != nil {
			providers := GetStringSlice(existing.Data["providers"])
			changed := false
			has := false
			for _, p := range providers {
				if p == provider {
					has = true
					break
				}
			}
			if !has {
				providers = append(providers, provider)
				existing.Data["providers"] = OrderProviders(providers)
				changed = true
			}
			extra := extraFor(modelKey)
			var keys []string
			if managedKeys != nil {
				keys = managedKeys
			} else {
				for k := range extra {
					keys = append(keys, k)
				}
			}
			var provCfg map[string]any
			if pcfg, ok := existing.Data["providerConfig"].(map[string]any); ok {
				if p, ok := pcfg[provider].(map[string]any); ok {
					provCfg = p
				}
			}
			hasManaged := false
			if provCfg != nil {
				for _, k := range keys {
					if _, ok := provCfg[k]; ok {
						hasManaged = true
						break
					}
				}
			} else if provCfg == nil {
				if _, ok := existing.Data["providerConfig"]; ok {
				} else {
					_ = provCfg
				}
			}
			needCfg := upstreamName != existing.ID || len(extra) > 0 || hasManaged
			if provCfg == nil {
				if pcfgRaw, ok := existing.Data["providerConfig"].(map[string]any); ok {
					if p, ok := pcfgRaw[provider].(map[string]any); ok {
						provCfg = p
						_ = provCfg
					}
				}
			}
			if provCfg != nil && provCfg["upstream"] != nil {
				needCfg = true
			}
			if needCfg {
				if _, ok := existing.Data["providerConfig"].(map[string]any); !ok {
					existing.Data["providerConfig"] = map[string]any{}
				}
				pcfg := existing.Data["providerConfig"].(map[string]any)
				if _, ok := pcfg[provider].(map[string]any); !ok {
					pcfg[provider] = map[string]any{}
				}
				next := pcfg[provider].(map[string]any)
				if applyManaged(next, modelKey) {
					changed = true
				}
				if upstreamName != existing.ID && next["upstream"] != upstreamName {
					next["upstream"] = upstreamName
					changed = true
				}
				if len(next) == 0 {
					delete(pcfg, provider)
				}
				if len(pcfg) == 0 {
					delete(existing.Data, "providerConfig")
				}
			}
			if changed {
				if err := WriteModelJSON(existing.Path, existing.Data); err != nil {
					return result, err
				}
				result.Updated = append(result.Updated, modelKey)
			}
		} else {
			folder := InferModelFolder(modelKey)
			var filePath string
			if folder != "" {
				filePath = filepath.Join(modelsDir, folder, modelKey+".json")
			} else {
				filePath = filepath.Join(modelsDir, modelKey+".json")
			}
			if _, err := os.Stat(filePath); err == nil {
				content, err := os.ReadFile(filePath)
				if err != nil {
					return result, err
				}
				var diskData map[string]any
				if err := json.Unmarshal(content, &diskData); err != nil {
					return result, err
				}
				diskProviders := GetStringSlice(diskData["providers"])
				touched := false
				has := false
				for _, p := range diskProviders {
					if p == provider {
						has = true
						break
					}
				}
				if !has {
					diskProviders = append(diskProviders, provider)
					diskData["providers"] = OrderProviders(diskProviders)
					touched = true
				}
				extra := extraFor(modelKey)
				diskID, _ := diskData["id"].(string)
				if diskID == "" {
					diskID = modelKey
				}
				var diskPcfg map[string]any
				if pcfg, ok := diskData["providerConfig"].(map[string]any); ok {
					if p, ok := pcfg[provider].(map[string]any); ok {
						diskPcfg = p
					}
				}
				wantsCfg := len(extra) > 0 || upstreamName != diskID || diskPcfg != nil
				if wantsCfg {
					if _, ok := diskData["providerConfig"].(map[string]any); !ok {
						diskData["providerConfig"] = map[string]any{}
					}
					pcfg := diskData["providerConfig"].(map[string]any)
					if _, ok := pcfg[provider].(map[string]any); !ok {
						pcfg[provider] = map[string]any{}
					}
					next := pcfg[provider].(map[string]any)
					for k, v := range extra {
						if !jsonEqual(next[k], v) {
							next[k] = v
							touched = true
						}
					}
					if upstreamName != modelKey && next["upstream"] != upstreamName {
						next["upstream"] = upstreamName
						touched = true
					}
					if len(next) == 0 {
						delete(pcfg, provider)
					}
					if len(pcfg) == 0 {
						delete(diskData, "providerConfig")
					}
				}
				if touched {
					if err := WriteModelJSON(filePath, diskData); err != nil {
						return result, err
					}
					result.Updated = append(result.Updated, modelKey)
				}
				continue
			}
			data := map[string]any{"providers": []string{provider}}
			pcfg := map[string]any{}
			for k, v := range extraFor(modelKey) {
				pcfg[k] = v
			}
			if upstreamName != modelKey {
				pcfg["upstream"] = upstreamName
			}
			if len(pcfg) > 0 {
				data["providerConfig"] = map[string]any{provider: pcfg}
			}
			if err := WriteModelJSON(filePath, data); err != nil {
				return result, err
			}
			result.Added = append(result.Added, modelKey)
			_ = reflect.TypeOf(nil)
		}
	}
	return result, nil
}
