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
	openCodeModelsURL = "https://opencode.ai/zen/v1/models"
	openCodeDocsURL   = "https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/web/src/content/docs/zen.mdx"
)

var openCodeSeparatorRe = regexp.MustCompile(`^\s*\|?\s*:?-{3,}:?\s*\|`)

func openCodeToModelKey(modelID string) string {
	cleaned := stripKey(modelID)
	return trimFreeSuffix(cleaned)
}

func openCodeSplitRow(row string) []string {
	t := strings.TrimSpace(row)
	t = strings.TrimPrefix(t, "|")
	t = strings.TrimSuffix(t, "|")
	parts := strings.Split(t, "|")
	for i, c := range parts {
		parts[i] = strings.TrimSpace(strings.ReplaceAll(c, "`", ""))
	}
	return parts
}

func openCodeParseTables(markdown string) (headersList [][]string, bodies [][][]string) {
	lines := strings.Split(markdown, "\n")
	for i := 0; i < len(lines)-1; i++ {
		if !strings.HasPrefix(strings.TrimSpace(lines[i]), "|") || !openCodeSeparatorRe.MatchString(lines[i+1]) {
			continue
		}
		rows := []string{}
		for j := i; j < len(lines) && strings.HasPrefix(strings.TrimSpace(lines[j]), "|"); j++ {
			rows = append(rows, lines[j])
			i = j
		}
		if len(rows) < 1 {
			continue
		}
		headersList = append(headersList, openCodeSplitRow(rows[0]))
		body := [][]string{}
		for _, r := range rows[2:] {
			body = append(body, openCodeSplitRow(r))
		}
		bodies = append(bodies, body)
	}
	return headersList, bodies
}

func openCodeHeaderIndex(headers []string, name string) int {
	for i, h := range headers {
		if strings.EqualFold(h, name) {
			return i
		}
	}
	return -1
}

func openCodeNameKey(name string) string {
	return strings.ToLower(strings.TrimSpace(regexp.MustCompile(`\s+`).ReplaceAllString(name, " ")))
}

func openCodeFreeIDsFromDocs(markdown string) ([]string, error) {
	headersList, bodies := openCodeParseTables(markdown)
	type table struct {
		headers []string
		body    [][]string
	}
	tables := []table{}
	for i := range headersList {
		tables = append(tables, table{headersList[i], bodies[i]})
	}
	var endpoints, pricing *table
	for i := range tables {
		t := &tables[i]
		if openCodeHeaderIndex(t.headers, "Model ID") != -1 && openCodeHeaderIndex(t.headers, "Endpoint") != -1 && endpoints == nil {
			endpoints = t
		}
		if openCodeHeaderIndex(t.headers, "Input") != -1 && openCodeHeaderIndex(t.headers, "Output") != -1 && openCodeHeaderIndex(t.headers, "Cached Read") != -1 && pricing == nil {
			pricing = t
		}
	}
	if endpoints == nil || pricing == nil {
		return nil, fmt.Errorf("Unexpected OpenCode Zen docs format: model endpoint or pricing table not found")
	}
	epModel := openCodeHeaderIndex(endpoints.headers, "Model")
	epID := openCodeHeaderIndex(endpoints.headers, "Model ID")
	prModel := openCodeHeaderIndex(pricing.headers, "Model")
	prIn := openCodeHeaderIndex(pricing.headers, "Input")
	prOut := openCodeHeaderIndex(pricing.headers, "Output")
	prCached := openCodeHeaderIndex(pricing.headers, "Cached Read")
	byName := map[string]string{}
	for _, row := range endpoints.body {
		if epModel < len(row) && epID < len(row) && row[epModel] != "" && row[epID] != "" {
			byName[openCodeNameKey(row[epModel])] = row[epID]
		}
	}
	ids := []string{}
	for _, row := range pricing.body {
		get := func(idx int) string {
			if idx < len(row) {
				return row[idx]
			}
			return ""
		}
		if !(strings.EqualFold(get(prIn), "free") && strings.EqualFold(get(prOut), "free") && strings.EqualFold(get(prCached), "free")) {
			continue
		}
		name := get(prModel)
		id, ok := byName[openCodeNameKey(name)]
		if !ok {
			return nil, fmt.Errorf("OpenCode Zen docs pricing model is missing from endpoint table: %s", name)
		}
		ids = append(ids, id)
	}
	if len(ids) == 0 {
		return nil, fmt.Errorf("OpenCode Zen docs did not list any free models")
	}
	sort.Strings(ids)
	return ids, nil
}

func SyncOpenCode(ctx context.Context, modelsDir string) (gosync.ProviderResult, error) {
	client := &http.Client{Timeout: 20 * time.Second}
	var docs string
	var payload struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	var wg sync.WaitGroup
	var docsErr, payloadErr error
	wg.Add(2)
	go func() {
		defer wg.Done()
		docs, docsErr = httpfetch.FetchText(ctx, client, openCodeDocsURL, &httpfetch.Options{Label: "OpenCode Zen docs"})
	}()
	go func() {
		defer wg.Done()
		payloadErr = httpfetch.FetchJSON(ctx, client, openCodeModelsURL, &payload, &httpfetch.Options{Label: "OpenCode model list"})
	}()
	wg.Wait()
	if docsErr != nil {
		return gosync.ProviderResult{Provider: "opencode"}, docsErr
	}
	if payloadErr != nil {
		return gosync.ProviderResult{Provider: "opencode"}, payloadErr
	}
	available := map[string]bool{}
	for _, m := range payload.Data {
		if id := strings.TrimSpace(m.ID); id != "" {
			available[id] = true
		}
	}
	freeIDs, err := openCodeFreeIDsFromDocs(docs)
	if err != nil {
		return gosync.ProviderResult{Provider: "opencode"}, err
	}
	missing := []string{}
	for _, id := range freeIDs {
		if !available[id] {
			missing = append(missing, id)
		}
	}
	if len(missing) > 0 {
		return gosync.ProviderResult{Provider: "opencode"}, fmt.Errorf("OpenCode Zen docs list free models missing from /zen/v1/models: %s", strings.Join(missing, ", "))
	}
	modelMap := map[string]string{}
	for _, id := range freeIDs {
		key := openCodeToModelKey(id)
		if _, ok := modelMap[key]; !ok {
			modelMap[key] = id
		}
	}
	modelMap = sortMap(modelMap)
	res, err := gosync.SyncProviderRegistry(modelsDir, "opencode", modelMap, nil, nil)
	if err != nil {
		return res, err
	}
	if len(res.Added) == 0 && len(res.Removed) == 0 && len(res.Updated) == 0 {
		fmt.Printf("Opencode free models are already up to date (%d models).\n", len(modelMap))
	} else {
		fmt.Printf("Opencode: %d free models (added %d, removed %d, updated %d).\n", len(modelMap), len(res.Added), len(res.Removed), len(res.Updated))
	}
	return res, nil
}
