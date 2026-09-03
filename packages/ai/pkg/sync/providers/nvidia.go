package providers

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/opendum/opendum/packages/ai/pkg/sync"
)

const nvidiaModelsURL = "https://integrate.api.nvidia.com/v1/models"

var excludedNvidiaTokens = []string{
	"detection", "embed", "embedding", "guard", "nemoretriever",
	"parse", "rerank", "retriever", "safety", "vila",
}

type NvidiaFetcher struct {
	Client *http.Client
}

func NewNvidiaFetcher() *NvidiaFetcher {
	return &NvidiaFetcher{
		Client: &http.Client{Timeout: 30 * time.Second},
	}
}

func (f *NvidiaFetcher) Name() string {
	return "nvidia_nim"
}

func (f *NvidiaFetcher) Fetch(ctx context.Context) (map[string]string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, nvidiaModelsURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")

	resp, err := f.Client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("nvidia returned %d", resp.StatusCode)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	var payload struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}

	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, fmt.Errorf("unmarshal nvidia models: %w", err)
	}

	result := map[string]string{}
	for _, m := range payload.Data {
		id := strings.TrimSpace(m.ID)
		if id == "" {
			continue
		}

		// Check exclusion
		lower := strings.ToLower(id)
		excluded := false
		for _, tok := range excludedNvidiaTokens {
			if strings.Contains(lower, tok) {
				excluded = true
				break
			}
		}
		if excluded {
			continue
		}

		key := sync.CleanKeyToModelKey(id)
		result[key] = id
	}

	return result, nil
}
