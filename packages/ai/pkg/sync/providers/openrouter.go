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

type OpenRouterFetcher struct {
	Client *http.Client
}

func NewOpenRouterFetcher() *OpenRouterFetcher {
	return &OpenRouterFetcher{
		Client: &http.Client{Timeout: 30 * time.Second},
	}
}

func (f *OpenRouterFetcher) Name() string {
	return "openrouter"
}

func (f *OpenRouterFetcher) Fetch(ctx context.Context) (map[string]string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://openrouter.ai/api/v1/models", nil)
	if err != nil {
		return nil, err
	}

	resp, err := f.Client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("openrouter returned %d", resp.StatusCode)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	var payload struct {
		Data []struct {
			ID      string `json:"id"`
			Pricing struct {
				Prompt     string `json:"prompt"`
				Completion string `json:"completion"`
			} `json:"pricing"`
		} `json:"data"`
	}

	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, err
	}

	result := map[string]string{}
	for _, m := range payload.Data {
		// Only free models
		if (m.Pricing.Prompt == "0" || m.Pricing.Prompt == "0.0") &&
			(m.Pricing.Completion == "0" || m.Pricing.Completion == "0.0") {
			modelID := strings.TrimSpace(m.ID)
			if modelID == "" {
				continue
			}
			key := sync.CleanKeyToModelKey(modelID)
			result[key] = modelID
		}
	}

	return result, nil
}
