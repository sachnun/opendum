package providers

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	gosync "github.com/opendum/opendum/packages/ai/pkg/sync"
	"github.com/opendum/opendum/packages/ai/pkg/sync/httpfetch"
)

const antigravityModelsURL = "https://antigravity.google/docs/models"

var (
	antigravityManagedKeys = []string{
		"anthropic_beta", "anthropic_beta_thinking", "convert_external_images",
		"force_stream_non_stream", "inject_thought_signature", "sanitize_tool_blocks",
		"scrub_model_artifacts", "signature_family", "strict_thought_signatures",
		"strict_tool_schema", "system_instruction", "thinking_budgets",
		"thinking_format", "thinking_levels", "thinking_model", "top_p_min_095",
	}
	antigravityGeminiLevelThinking = map[string]any{"high": "high", "low": "low", "medium": "medium", "none": "minimal", "xhigh": "high"}
	antigravityFlashBudgets        = map[string]any{"high": 24576, "low": 6144, "medium": 12288, "xhigh": 24576}
	antigravityProBudgets          = map[string]any{"high": 32768, "low": 8192, "medium": 16384, "xhigh": 32768}
	antigravity35Levels            = []string{"minimal", "low", "medium", "high"}
	antigravity36Levels            = []string{"low", "medium", "high"}
	antigravity31Levels            = []string{"low", "medium", "high"}
	antigravityBackendOverrides    = map[string]struct{ key, upstream string }{
		"Gemini 3.6 Flash":             {key: "gemini-3.6-flash", upstream: "gemini-3.6-flash-medium"},
		"Gemini 3.5 Flash":             {key: "gemini-3.5-flash", upstream: "gemini-3.5-flash-medium"},
		"Claude Sonnet 4.6 (thinking)": {key: "claude-sonnet-4-6", upstream: "claude-sonnet-4-6"},
		"Claude Opus 4.6 (thinking)":   {key: "claude-opus-4-6", upstream: "claude-opus-4-6-thinking"},
		"GPT-OSS-120b":                 {key: "gpt-oss-120b", upstream: "gpt-oss-120b-medium"},
	}
)

func antigravityAliases(key string) []string {
	switch key {
	case "gemini-3.6-flash":
		return prefixedAliases("gemini-3.6-flash", antigravity36Levels)
	case "gemini-3.5-flash":
		return prefixedAliases("gemini-3.5-flash", antigravity35Levels)
	case "gemini-3.1-pro":
		return prefixedAliases("gemini-3.1-pro", antigravity31Levels)
	}
	return nil
}

func prefixedAliases(base string, levels []string) []string {
	out := make([]string, 0, len(levels))
	for _, l := range levels {
		out = append(out, base+"-"+l)
	}
	return out
}

func antigravityMarkdown(html string) string {
	sectionRe := regexp.MustCompile(`(?is)<h2[^>]*id=["']reasoning-model["'][^>]*>.*?</h2>\s*(.*?)(?:<h2[^>]*>|$)`)
	m := sectionRe.FindStringSubmatch(html)
	if m == nil {
		return ""
	}
	tableRe := regexp.MustCompile(`(?is)<table[^>]*>(.*?)</table>`)
	tm := tableRe.FindStringSubmatch(m[1])
	if tm == nil {
		return ""
	}
	trRe := regexp.MustCompile(`(?is)<tr[^>]*>(.*?)</tr>`)
	cellRe := regexp.MustCompile(`(?is)<t[dh][^>]*>(.*?)</t[dh]>`)
	tagRe := regexp.MustCompile(`<[^>]+>`)
	rows := []string{}
	for _, tr := range trRe.FindAllStringSubmatch(tm[1], -1) {
		cells := []string{}
		for _, cm := range cellRe.FindAllStringSubmatch(tr[1], -1) {
			cells = append(cells, strings.TrimSpace(tagRe.ReplaceAllString(cm[1], "")))
		}
		nonEmpty := []string{}
		for _, c := range cells {
			if c != "" {
				nonEmpty = append(nonEmpty, c)
			}
		}
		if len(nonEmpty) > 0 {
			rows = append(rows, "| "+strings.Join(nonEmpty, " | ")+" |")
		}
	}
	return "## Reasoning Model\n\n" + strings.Join(rows, "\n") + "\n"
}

func antigravityParseNames(markdown string) ([]string, error) {
	sectionRe := regexp.MustCompile(`(?s)## Reasoning Model\s+(.*?)(?:\n## |$)`)
	m := sectionRe.FindStringSubmatch(markdown)
	if m == nil {
		return nil, fmt.Errorf("Could not find Reasoning Model section in Antigravity docs.")
	}
	sepRe := regexp.MustCompile(`^\|[\s:-]+\|$`)
	models := []string{}
	pastHeader := false
	for _, line := range strings.Split(m[1], "\n") {
		trimmed := strings.TrimSpace(line)
		if !strings.HasPrefix(trimmed, "|") || sepRe.MatchString(trimmed) {
			continue
		}
		if !pastHeader {
			if fm := regexp.MustCompile(`^\|\s+(.+?)\s+\|`).FindStringSubmatch(trimmed); fm != nil {
				if regexp.MustCompile(`(?i)model`).MatchString(strings.TrimSpace(fm[1])) {
					continue
				}
			}
			pastHeader = true
		}
		fm := regexp.MustCompile(`^\|\s+(.+?)\s+\|`).FindStringSubmatch(trimmed)
		if fm == nil {
			continue
		}
		name := strings.TrimSpace(antigravityStripMD(fm[1]))
		if name == "" || regexp.MustCompile(`(?i)^nano banana`).MatchString(name) {
			continue
		}
		models = append(models, name)
	}
	uniq := []string{}
	seen := map[string]bool{}
	for _, n := range models {
		if !seen[n] {
			seen[n] = true
			uniq = append(uniq, n)
		}
	}
	if len(uniq) == 0 {
		return nil, fmt.Errorf("No Antigravity reasoning models found in official docs.")
	}
	return uniq, nil
}

var claudeDotDigitRe = regexp.MustCompile(`([0-9])\.([0-9])`)

func replaceDotBeforeDigit(s string) string {
	for {
		next := claudeDotDigitRe.ReplaceAllString(s, "$1-$2")
		if next == s {
			return s
		}
		s = next
	}
}

func antigravityStripMD(v string) string {
	v = strings.ReplaceAll(v, "**", "")
	v = strings.ReplaceAll(v, "`", "")
	return strings.TrimSpace(regexp.MustCompile(`\\\s*$`).ReplaceAllString(v, ""))
}

func antigravityIDFromDisplay(display string) string {
	cleaned := regexp.MustCompile(`\([^)]*\)`).ReplaceAllString(display, " ")
	cleaned = regexp.MustCompile(`(?i)\bpreview\b`).ReplaceAllString(cleaned, " ")
	cleaned = strings.TrimSpace(regexp.MustCompile(`\s+`).ReplaceAllString(cleaned, " "))
	lower := strings.ToLower(cleaned)
	if m := regexp.MustCompile(`\bgpt\s*[- ]?\s*oss\s*[- ]?\s*(\d+)\s*b\b`).FindStringSubmatch(lower); m != nil {
		return "gpt-oss-" + m[1] + "b"
	}
	id := regexp.MustCompile(`\b(google|anthropic|openai)\b`).ReplaceAllString(lower, "")
	id = regexp.MustCompile(`\b(claude|gemini)\s+(opus|sonnet|haiku|flash|pro)`).ReplaceAllString(id, "$1-$2")
	id = regexp.MustCompile(`\s+`).ReplaceAllString(id, "-")
	id = regexp.MustCompile(`[^a-z0-9._-]+`).ReplaceAllString(id, "-")
	id = regexp.MustCompile(`-+`).ReplaceAllString(id, "-")
	id = strings.Trim(id, "-")
	if strings.HasPrefix(id, "claude-") {
		id = replaceDotBeforeDigit(id)
	}
	return stripKey(id)
}

type antigravityDiscovered struct {
	display  string
	key      string
	upstream string
	thinking bool
}

func antigravityCanonicalize(display string) *antigravityDiscovered {
	lower := strings.ToLower(display)
	if ov, ok := antigravityBackendOverrides[display]; ok {
		return &antigravityDiscovered{display: display, key: ov.key, upstream: ov.upstream, thinking: strings.Contains(lower, "thinking")}
	}
	base := antigravityIDFromDisplay(display)
	if base == "" {
		return nil
	}
	e := &antigravityDiscovered{display: display, key: base, upstream: base, thinking: strings.Contains(lower, "thinking")}
	if strings.HasPrefix(base, "gemini-") {
		if base == "gemini-3-pro" {
			e.key = "gemini-3.1-pro-preview"
			if strings.Contains(lower, "low") {
				e.upstream = "gemini-3.1-pro-low"
			} else {
				e.upstream = "gemini-3.1-pro-high"
			}
			return e
		}
		if regexp.MustCompile(`^gemini-\d+(?:\.\d+)*-pro$`).MatchString(base) && strings.Contains(lower, "low") {
			e.key = base + "-preview"
			e.upstream = base + "-low"
			return e
		}
		if regexp.MustCompile(`^gemini-\d+(?:\.\d+)*-pro$`).MatchString(base) && strings.Contains(lower, "high") {
			e.key = base + "-preview"
			e.upstream = base + "-high"
			return e
		}
		if base == "gemini-3-flash" {
			e.key = "gemini-3-flash-preview"
			e.upstream = "gemini-3-flash"
			return e
		}
	}
	if strings.HasPrefix(base, "claude-") && strings.Contains(lower, "thinking") {
		e.key = base
		e.upstream = base + "-thinking"
	}
	return e
}

func antigravityRank(upstream string) int {
	switch {
	case strings.HasSuffix(upstream, "-high"):
		return 3
	case strings.HasSuffix(upstream, "-medium"):
		return 2
	case strings.HasSuffix(upstream, "-low"):
		return 1
	}
	return 0
}

func antigravityIsManaged(key string) bool {
	return (strings.HasPrefix(key, "gemini-") && !strings.Contains(key, "image")) || strings.HasPrefix(key, "claude-")
}

func antigravityGeminiConfig(key string) map[string]any {
	cfg := map[string]any{
		"inject_thought_signature": true,
		"scrub_model_artifacts":    true,
		"signature_family":         "gemini-flash",
	}
	if strings.Contains(key, "pro") {
		cfg["signature_family"] = "gemini-pro"
	}
	if regexp.MustCompile(`^gemini-3`).MatchString(key) && !strings.Contains(key, "image") {
		cfg["system_instruction"] = true
	}
	if regexp.MustCompile(`^gemini-3`).MatchString(key) && !strings.Contains(key, "pro") && !strings.Contains(key, "image") {
		cfg["thinking_format"] = "level"
		cfg["thinking_levels"] = antigravityGeminiLevelThinking
	} else if !strings.Contains(key, "image") {
		cfg["thinking_format"] = "budget"
		if strings.Contains(key, "pro") {
			cfg["thinking_budgets"] = antigravityProBudgets
		} else {
			cfg["thinking_budgets"] = antigravityFlashBudgets
		}
	}
	return cfg
}

func antigravityClaudeConfig(upstream string, documentedThinking bool) map[string]any {
	thinking := documentedThinking || strings.HasSuffix(upstream, "-thinking")
	cfg := map[string]any{
		"anthropic_beta":            true,
		"convert_external_images":   true,
		"force_stream_non_stream":   true,
		"sanitize_tool_blocks":      true,
		"signature_family":          "claude",
		"strict_thought_signatures": true,
		"strict_tool_schema":        true,
		"system_instruction":        true,
		"top_p_min_095":             true,
	}
	if thinking {
		cfg["anthropic_beta_thinking"] = true
		cfg["thinking_model"] = true
	}
	return cfg
}

func antigravityInferMeta(key string) map[string]any {
	switch {
	case strings.HasPrefix(key, "gemini-"):
		image := strings.Contains(key, "image")
		return map[string]any{"reasoning": !image, "toolCall": !image, "vision": true}
	case strings.HasPrefix(key, "claude-"):
		return map[string]any{"reasoning": true, "toolCall": true, "vision": true}
	case strings.HasPrefix(key, "gpt-oss-"):
		return map[string]any{"reasoning": true, "toolCall": true, "vision": false}
	}
	return nil
}

func SyncAntigravity(ctx context.Context, modelsDir string) (gosync.ProviderResult, error) {
	client := &http.Client{Timeout: 20 * time.Second}
	markdown, err := httpfetch.FetchText(ctx, client, antigravityModelsURL, &httpfetch.Options{Label: "Antigravity model docs"})
	if err != nil {
		if strings.Contains(err.Error(), "404") {
			fmt.Printf("[antigravity] Docs unavailable (404). Skipping sync — existing models preserved.\n")
			return gosync.ProviderResult{Provider: "antigravity"}, nil
		}
		return gosync.ProviderResult{Provider: "antigravity"}, err
	}
	fmt.Printf("[antigravity] Fetching official Antigravity model docs ...\n")
	names, err := antigravityParseNames(antigravityMarkdown(markdown))
	if err != nil {
		return gosync.ProviderResult{Provider: "antigravity"}, err
	}
	modelMap := map[string]string{}
	ranks := map[string]int{}
	discovered := []antigravityDiscovered{}
	for _, display := range names {
		e := antigravityCanonicalize(display)
		if e == nil {
			continue
		}
		discovered = append(discovered, *e)
		if rank := antigravityRank(e.upstream); true {
			if _, ok := modelMap[e.key]; !ok || rank > ranks[e.key] {
				modelMap[e.key] = e.upstream
				ranks[e.key] = rank
			}
		}
	}
	if len(modelMap) == 0 {
		return gosync.ProviderResult{Provider: "antigravity"}, fmt.Errorf("No Antigravity model IDs could be derived from official docs.")
	}
	index, err := gosync.BuildDiskIndex(modelsDir)
	if err != nil {
		return gosync.ProviderResult{Provider: "antigravity"}, err
	}
	extras := []struct{ key, upstream string }{}
	for _, entry := range index {
		has := false
		for _, p := range gosync.GetStringSlice(entry.Data["providers"]) {
			if p == "antigravity" {
				has = true
				break
			}
		}
		if !has || modelMap[entry.FileID] != "" {
			// need existence check via key presence
			if _, ok := modelMap[entry.FileID]; ok {
				continue
			}
			if !has {
				continue
			}
		} else {
			// has provider and not in map
		}
		if !has {
			continue
		}
		if _, ok := modelMap[entry.FileID]; ok {
			continue
		}
		up := gosync.GetProviderUpstream(entry.Data, "antigravity", entry.FileID)
		if up == "" {
			up = entry.FileID
		}
		modelMap[entry.FileID] = up
		extras = append(extras, struct{ key, upstream string }{entry.FileID, up})
	}
	for _, entry := range index {
		id := entry.ID
		if id == "" || id == entry.FileID {
			continue
		}
		if _, ok := modelMap[id]; ok {
			continue
		}
		has := false
		for _, p := range gosync.GetStringSlice(entry.Data["providers"]) {
			if p == "antigravity" {
				has = true
				break
			}
		}
		if !has {
			continue
		}
		up := gosync.GetProviderUpstream(entry.Data, "antigravity", entry.FileID)
		if up == "" {
			up = id
		}
		modelMap[id] = up
		extras = append(extras, struct{ key, upstream string }{id, up})
	}
	thinkingKeys := map[string]bool{}
	for _, d := range discovered {
		if strings.HasPrefix(d.key, "claude-") && d.thinking {
			thinkingKeys[d.key] = true
		}
	}
	extra := map[string]map[string]any{}
	findEntry := func(key string) *gosync.DiskModelEntry {
		for _, e := range index {
			if e.FileID == key || e.ID == key {
				return e
			}
		}
		for _, e := range index {
			if e.Data["ignored"] == true {
				continue
			}
			for _, a := range gosync.GetStringSlice(e.Data["aliases"]) {
				if a == key {
					return e
				}
			}
		}
		return nil
	}
	for key, upstream := range modelMap {
		existing := findEntry(key)
		var existingCfg map[string]any
		if existing != nil {
			if pcfg, ok := existing.Data["providerConfig"].(map[string]any); ok {
				if c, ok := pcfg["antigravity"].(map[string]any); ok {
					existingCfg = c
				}
			}
		}
		if existing != nil && !antigravityIsManaged(key) {
			m := map[string]any{}
			for _, mk := range antigravityManagedKeys {
				m[mk] = existingCfg[mk]
			}
			extra[key] = m
			continue
		}
		if strings.HasPrefix(key, "gemini-") {
			extra[key] = antigravityGeminiConfig(key)
			continue
		}
		if strings.HasPrefix(key, "claude-") {
			extra[key] = antigravityClaudeConfig(upstream, thinkingKeys[key])
		}
	}
	fmt.Printf("[antigravity] Found %d documented reasoning models and preserved %d JSON-configured extras.\n", len(discovered), len(extras))
	res, err := gosync.SyncProviderRegistry(modelsDir, "antigravity", modelMap, extra, antigravityManagedKeys)
	if err != nil {
		return res, err
	}
	if len(res.Added) > 0 || len(res.Updated) > 0 {
		idx2, err := gosync.BuildDiskIndex(modelsDir)
		if err == nil {
			documented := map[string]bool{}
			for k := range modelMap {
				// documented keys are those from discovered; extras merged too but enrich only discovered
				documented[k] = true
			}
			_ = documented
			changed := append(append([]string{}, res.Added...), res.Updated...)
			for _, key := range changed {
				e := func() *gosync.DiskModelEntry {
					for _, en := range idx2 {
						if en.FileID == key || en.ID == key {
							return en
						}
					}
					return nil
				}()
				if e == nil {
					continue
				}
				modified := false
				if e.Data["ignored"] == true {
					// only un-ignore if documented
					isDoc := false
					for _, d := range discovered {
						if d.key == key {
							isDoc = true
							break
						}
					}
					if isDoc {
						delete(e.Data, "ignored")
						modified = true
					}
				}
				if nextMeta := antigravityInferMeta(key); nextMeta != nil {
					if !jsonMapsEqual(e.Data["meta"], nextMeta) {
						e.Data["meta"] = nextMeta
						modified = true
					}
				}
				if desired := antigravityAliases(key); len(desired) > 0 {
					set := map[string]bool{}
					for _, a := range gosync.GetStringSlice(e.Data["aliases"]) {
						set[a] = true
					}
					for _, a := range desired {
						set[a] = true
					}
					next := make([]string, 0, len(set))
					for a := range set {
						next = append(next, a)
					}
					sort.Strings(next)
					cur := gosync.GetStringSlice(e.Data["aliases"])
					sort.Strings(cur)
					if !stringSlicesEqual(cur, next) {
						e.Data["aliases"] = next
						modified = true
					}
				}
				if modified {
					_ = gosync.WriteModelJSON(e.Path, e.Data)
				}
			}
		}
	}
	if len(res.Added) == 0 && len(res.Removed) == 0 && len(res.Updated) == 0 {
		fmt.Printf("[antigravity] JSON models are already up to date (%d models).\n", len(modelMap))
	} else {
		fmt.Printf("[antigravity] Synced %d models (added: %d, removed: %d, updated: %d).\n", len(modelMap), len(res.Added), len(res.Removed), len(res.Updated))
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
	fmt.Println()
	if err := antigravityUpdateQuotaTS(modelsDir, modelMap); err != nil {
		return res, err
	}
	return res, nil
}

func jsonMapsEqual(a any, b map[string]any) bool {
	am, ok := a.(map[string]any)
	if !ok {
		return false
	}
	if len(am) != len(b) {
		return false
	}
	for k, v := range b {
		if av, ok := am[k]; !ok || fmt.Sprintf("%v", av) != fmt.Sprintf("%v", v) {
			return false
		}
	}
	return true
}

func stringSlicesEqual(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func antigravityUpdateQuotaTS(modelsDir string, modelMap map[string]string) error {
	root := filepath.Join(modelsDir, "..", "..", "..")
	quotaPath := filepath.Join(root, "apps", "dashboard", "server", "lib", "providers", "antigravity", "quota.ts")
	source, err := os.ReadFile(quotaPath)
	if err != nil {
		return err
	}
	updated := string(source)
	index, err := gosync.BuildDiskIndex(modelsDir)
	if err != nil {
		return err
	}
	findEntry := func(key string) *gosync.DiskModelEntry {
		for _, e := range index {
			if e.FileID == key || e.ID == key {
				return e
			}
		}
		return nil
	}
	apiToUser := map[string]string{}
	for key, upstream := range modelMap {
		if key != upstream {
			apiToUser[upstream] = key
		}
		if e := findEntry(key); e != nil {
			for _, alias := range gosync.GetStringSlice(e.Data["aliases"]) {
				if alias != key {
					apiToUser[alias] = key
				}
			}
		}
		if strings.HasPrefix(key, "gemini-") && strings.Contains(key, "pro") && !strings.Contains(key, "image") {
			base := regexp.MustCompile(`-(low|medium|high)$`).ReplaceAllString(upstream, "")
			for _, lvl := range []string{"low", "medium", "high"} {
				apiToUser[base+"-"+lvl] = key
			}
		}
		if key == "gemini-3.5-flash" {
			base := regexp.MustCompile(`-(minimal|low|medium|high)$`).ReplaceAllString(upstream, "")
			for _, lvl := range antigravity35Levels {
				apiToUser[base+"-"+lvl] = key
			}
		}
	}
	userToAPI := map[string]string{}
	for key, upstream := range modelMap {
		if key != upstream {
			userToAPI[key] = upstream
		}
	}
	after := replaceConstRecord(updated, "USER_TO_API_MODEL_MAP", userToAPI)
	after = replaceConstRecord(after, "API_TO_USER_MODEL_MAP", apiToUser)
	if after != updated {
		if err := os.WriteFile(quotaPath, []byte(after), 0644); err != nil {
			return err
		}
		fmt.Printf("[antigravity] Updated quota.ts model maps\n")
	} else {
		fmt.Printf("[antigravity] quota.ts already up to date.\n")
	}
	return nil
}

func replaceConstRecord(source, constName string, values map[string]string) string {
	entries := make([]string, 0, len(values))
	keys := make([]string, 0, len(values))
	for k := range values {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		entries = append(entries, fmt.Sprintf("  %q: %q,", k, values[k]))
	}
	body := ""
	if len(entries) > 0 {
		body = strings.Join(entries, "\n") + "\n"
	}
	replacement := fmt.Sprintf("const %s: Record<string, string> = {\n%s};", constName, body)
	re := regexp.MustCompile(`const\s+` + regexp.QuoteMeta(constName) + `:\s*Record<string, string>\s*=\s*\{[\s\S]*?\n\};`)
	if !re.MatchString(source) {
		panic("Could not find " + constName + " in quota.ts")
	}
	return re.ReplaceAllString(source, replacement)
}
