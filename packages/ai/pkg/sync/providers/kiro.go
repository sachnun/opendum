package providers

import (
	"context"
	"fmt"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"time"

	gosync "github.com/opendum/opendum/packages/ai/pkg/sync"
	"github.com/opendum/opendum/packages/ai/pkg/sync/httpfetch"
)

const kiroDocsURL = "https://kiro.dev/docs/models/"

var (
	kiroIgnoredDisplay = map[string]bool{"Auto": true}
	kiroPaidTiers      = []any{"pro", "pro+", "power", "standalone"}
	kiroIDOverrides    = map[string]string{"Claude Sonnet 4.0": "claude-sonnet-4"}
	kiro1MVariants     = map[string]bool{"claude-opus-4.6": true, "claude-sonnet-4.6": true, "claude-sonnet-4.5": true}
)

func kiroStripHTML(s string) string {
	s = regexp.MustCompile(`<[^>]*>`).ReplaceAllString(s, "")
	s = strings.ReplaceAll(s, "&amp;", "&")
	s = strings.ReplaceAll(s, "&lt;", "<")
	s = strings.ReplaceAll(s, "&gt;", ">")
	s = strings.ReplaceAll(s, "&quot;", `"`)
	s = strings.ReplaceAll(s, "&#x27;", "'")
	s = strings.ReplaceAll(s, "&#39;", "'")
	s = strings.ReplaceAll(s, "&nbsp;", " ")
	return strings.TrimSpace(s)
}

type kiroOfficial struct {
	name          string
	freeAvailable bool
	paidAvailable bool
}

func kiroParseTableRows(tableHTML string) [][]string {
	rows := [][]string{}
	rowRe := regexp.MustCompile(`(?is)<tr[^>]*>(.*?)</tr>`)
	cellRe := regexp.MustCompile(`(?is)<t[dh][^>]*>(.*?)</t[dh]>`)
	for _, rm := range rowRe.FindAllStringSubmatch(tableHTML, -1) {
		cells := []string{}
		for _, cm := range cellRe.FindAllStringSubmatch(rm[1], -1) {
			cells = append(cells, kiroStripHTML(cm[1]))
		}
		if len(cells) > 0 {
			rows = append(rows, cells)
		}
	}
	return rows
}

func kiroParseOfficial(html string) ([]kiroOfficial, error) {
	tableRe := regexp.MustCompile(`(?is)<table[^>]*>(.*?)</table>`)
	var tables []string
	for _, m := range tableRe.FindAllStringSubmatch(html, -1) {
		tables = append(tables, m[1])
	}
	if len(tables) == 0 {
		return nil, fmt.Errorf("No tables found on Kiro docs page. The page structure may have changed.")
	}
	var comparison string
	found := false
	for _, t := range tables {
		rows := kiroParseTableRows(t)
		if len(rows) == 0 {
			continue
		}
		header := []string{}
		for _, h := range rows[0] {
			header = append(header, strings.ToLower(h))
		}
		hasModel, hasCtx := false, false
		for _, h := range header {
			if h == "model" || strings.Contains(h, "model") {
				hasModel = true
			}
			if strings.Contains(h, "context") {
				hasCtx = true
			}
		}
		if hasModel && hasCtx {
			comparison = t
			found = true
			break
		}
	}
	if !found {
		return nil, fmt.Errorf("Could not find \"Quick comparison\" table on Kiro docs page. The page structure may have changed.")
	}
	rows := kiroParseTableRows(comparison)
	if len(rows) < 2 {
		return nil, fmt.Errorf("Models table has fewer than 2 rows (header + data).")
	}
	header := []string{}
	for _, h := range rows[0] {
		header = append(header, strings.ToLower(h))
	}
	idxOf := func(pred func(string) bool) int {
		for i, h := range header {
			if pred(h) {
				return i
			}
		}
		return -1
	}
	nameIdx := idxOf(func(h string) bool { return h == "model" || strings.Contains(h, "model") })
	freeIdx := idxOf(func(h string) bool { return h == "free" })
	proIdx := idxOf(func(h string) bool { return h == "pro" })
	proPlusIdx := idxOf(func(h string) bool {
		return h == "pro+" || h == "pro plus" || (strings.HasPrefix(h, "pro") && strings.Contains(h, "+"))
	})
	powerIdx := idxOf(func(h string) bool { return h == "power" })
	if nameIdx < 0 {
		return nil, fmt.Errorf("Could not find 'Model' column in comparison table.")
	}
	cell := func(row []string, idx int) string {
		if idx >= 0 && idx < len(row) {
			return strings.TrimSpace(row[idx])
		}
		return ""
	}
	models := []kiroOfficial{}
	for _, row := range rows[1:] {
		name := cell(row, nameIdx)
		if name == "" {
			continue
		}
		free := cell(row, freeIdx) != ""
		paid := cell(row, proIdx) != "" || cell(row, proPlusIdx) != "" || cell(row, powerIdx) != ""
		models = append(models, kiroOfficial{name: name, freeAvailable: free, paidAvailable: paid})
	}
	if len(models) == 0 {
		return nil, fmt.Errorf("No models found in comparison table.")
	}
	return models, nil
}

func kiroDisplayToID(display string) string {
	if v, ok := kiroIDOverrides[display]; ok {
		return v
	}
	id := strings.ToLower(strings.Join(strings.Fields(display), "-"))
	id = regexp.MustCompile(`^minimax-(\d)`).ReplaceAllString(id, "minimax-m$1")
	return id
}

func kiroExpandVariants(id string) []string {
	if kiro1MVariants[id] {
		return []string{id, id + "-1m"}
	}
	return []string{id}
}

func kiroToCanonical(kiroID string) (key, upstream string) {
	key = kiroID
	if strings.HasPrefix(key, "claude-") {
		key = regexp.MustCompile(`(\d+)\.(\d+)`).ReplaceAllString(key, "$1-$2")
	}
	if strings.HasPrefix(key, "deepseek-") && regexp.MustCompile(`^deepseek-\d`).MatchString(key) {
		key = regexp.MustCompile(`^deepseek-`).ReplaceAllString(key, "deepseek-v")
	}
	key = stripKey(key)
	return key, kiroID
}

func SyncKiro(ctx context.Context, modelsDir string) (gosync.ProviderResult, error) {
	client := &http.Client{Timeout: 20 * time.Second}
	html, err := httpfetch.FetchText(ctx, client, kiroDocsURL, &httpfetch.Options{Label: "Kiro docs"})
	if err != nil {
		return gosync.ProviderResult{Provider: "kiro"}, err
	}
	official, err := kiroParseOfficial(html)
	if err != nil {
		return gosync.ProviderResult{Provider: "kiro"}, err
	}
	names := []string{}
	for _, m := range official {
		names = append(names, m.name)
	}
	fmt.Printf("[kiro] Fetching models from %s ...\n", kiroDocsURL)
	fmt.Printf("[kiro] Found %d models on docs page: %s\n", len(official), strings.Join(names, ", "))
	paidOnly := map[string]bool{}
	for _, m := range official {
		if kiroIgnoredDisplay[m.name] {
			continue
		}
		if !m.freeAvailable && m.paidAvailable {
			paidOnly[m.name] = true
		}
	}
	allIDs := []string{}
	for _, m := range official {
		if kiroIgnoredDisplay[m.name] {
			continue
		}
		allIDs = append(allIDs, kiroExpandVariants(kiroDisplayToID(m.name))...)
	}
	fmt.Printf("[kiro] Generated %d Kiro API model IDs.\n", len(allIDs))
	modelMap := map[string]string{}
	for _, id := range allIDs {
		key, upstream := kiroToCanonical(id)
		modelMap[key] = upstream
	}
	fmt.Printf("[kiro] Mapped to %d canonical model keys.\n", len(modelMap))
	extra := map[string]map[string]any{}
	for _, m := range official {
		if kiroIgnoredDisplay[m.name] || !paidOnly[m.name] {
			continue
		}
		for _, id := range kiroExpandVariants(kiroDisplayToID(m.name)) {
			key, _ := kiroToCanonical(id)
			extra[key] = map[string]any{"allowedTiers": kiroPaidTiers}
		}
	}
	res, err := gosync.SyncProviderRegistry(modelsDir, "kiro", modelMap, extra, []string{"allowedTiers"})
	if err != nil {
		return res, err
	}
	if len(res.Added) == 0 && len(res.Removed) == 0 && len(res.Updated) == 0 {
		fmt.Printf("[kiro] Models are already up to date (%d models).\n", len(modelMap))
	} else {
		fmt.Printf("[kiro] Synced %d models (added: %d, removed: %d, updated: %d).\n", len(modelMap), len(res.Added), len(res.Removed), len(res.Updated))
		if len(res.Added) > 0 {
			sorted := append([]string{}, res.Added...)
			sort.Strings(sorted)
			fmt.Printf("  Added: %s\n", strings.Join(sorted, ", "))
		}
		if len(res.Removed) > 0 {
			sorted := append([]string{}, res.Removed...)
			sort.Strings(sorted)
			fmt.Printf("  Removed: %s\n", strings.Join(sorted, ", "))
		}
		if len(res.Updated) > 0 {
			sorted := append([]string{}, res.Updated...)
			sort.Strings(sorted)
			fmt.Printf("  Updated: %s\n", strings.Join(sorted, ", "))
		}
	}
	return res, nil
}
