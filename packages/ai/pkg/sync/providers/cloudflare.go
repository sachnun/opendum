package providers

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/opendum/opendum/packages/ai/pkg/sync/cleankey"
)

const cloudflareDocsAPIURL = "https://unroxy.koyeb.app/api.github.com/repos/cloudflare/cloudflare-docs/contents/src/content/workers-ai-models?ref=production"

type CloudflareFetcher struct {
	Client *http.Client
}

func NewCloudflareFetcher() *CloudflareFetcher {
	return &CloudflareFetcher{
		Client: &http.Client{Timeout: 30 * time.Second},
	}
}

func (f *CloudflareFetcher) Name() string {
	return "workers_ai"
}

func (f *CloudflareFetcher) Fetch(ctx context.Context) (map[string]string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, cloudflareDocsAPIURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "Opendum-Sync/1.0")

	resp, err := f.Client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("cloudflare docs API returned %d", resp.StatusCode)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	var files []struct {
		Name string `json:"name"`
		Type string `json:"type"`
	}

	if err := json.Unmarshal(body, &files); err != nil {
		return nil, err
	}

	result := map[string]string{}
	for _, file := range files {
		if file.Type != "file" || !strings.HasSuffix(file.Name, ".json") {
			continue
		}
		raw := strings.TrimSuffix(file.Name, ".json")
		if strings.Contains(raw, "guard") || strings.Contains(raw, "embedding") {
			continue
		}

		key := cleankey.StripParamInfoKey(raw)
		upstream := fmt.Sprintf("@cf/%s", strings.ReplaceAll(raw, "-", "/"))
		result[key] = upstream
	}

	return result, nil
}
