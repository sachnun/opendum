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
	"github.com/opendum/opendum/packages/ai/pkg/sync/cleankey"
)

const kiloCodeModelsURL = "https://api.kilo.ai/api/gateway/models"

type KiloCodeFetcher struct {
	Client *http.Client
}

func NewKiloCodeFetcher() *KiloCodeFetcher {
	return &KiloCodeFetcher{
		Client: &http.Client{Timeout: 30 * time.Second},
	}
}

func (f *KiloCodeFetcher) Name() string {
	return "kilo_code"
}

func (f *KiloCodeFetcher) Fetch(ctx context.Context) (map[string]string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, kiloCodeModelsURL, nil)
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
		return nil, fmt.Errorf("kilo code api returned status %d", resp.StatusCode)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	var payload struct {
		Data []struct {
			ID     string `json:"id"`
			IsFree bool   `json:"isFree"`
		} `json:"data"`
	}

	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, fmt.Errorf("unmarshal kilo code models: %w", err)
	}

	result := map[string]string{}
	for _, m := range payload.Data {
		if !m.IsFree {
			continue
		}
		modelID := strings.TrimSpace(m.ID)
		if modelID == "" {
			continue
		}

		if modelID == "x-ai/grok-code-fast-1:optimized:free" {
			result["grok-code-fast-1"] = modelID
			continue
		}

		if strings.HasPrefix(modelID, "kilo-auto/") {
			key := cleankey.StripParamInfoKey(strings.ReplaceAll(modelID, "/", "-"))
			result[key] = modelID
			continue
		}

		clean := modelID
		if idx := strings.Index(clean, "/"); idx != -1 {
			clean = clean[idx+1:]
		}
		clean = strings.TrimSuffix(clean, ":free")
		key := sync.CleanKeyToModelKey(clean)
		result[key] = modelID
	}

	return result, nil
}
