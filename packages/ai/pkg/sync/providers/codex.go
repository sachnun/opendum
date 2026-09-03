package providers

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

const codexModelsURL = "https://raw.githubusercontent.com/openai/codex/main/codex-rs/models-manager/models.json"

var chatgptCompatibleCodexModels = map[string]struct{}{
	"gpt-5.5":       {},
	"gpt-5.4":       {},
	"gpt-5.4-mini":  {},
	"gpt-5.3-codex": {},
	"gpt-5.2":       {},
}

type CodexFetcher struct {
	Client *http.Client
}

func NewCodexFetcher() *CodexFetcher {
	return &CodexFetcher{
		Client: &http.Client{Timeout: 30 * time.Second},
	}
}

func (f *CodexFetcher) Name() string {
	return "codex"
}

func (f *CodexFetcher) Fetch(ctx context.Context) (map[string]string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, codexModelsURL, nil)
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
		return nil, fmt.Errorf("codex repo returned status %d", resp.StatusCode)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	var payload struct {
		Models []struct {
			Slug            string `json:"slug"`
			Visibility      string `json:"visibility"`
			SupportedInAPI  *bool  `json:"supported_in_api"`
		} `json:"models"`
	}

	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, fmt.Errorf("unmarshal codex models: %w", err)
	}

	result := map[string]string{}
	for _, m := range payload.Models {
		if m.Slug == "" {
			continue
		}
		if m.Visibility != "" && m.Visibility != "list" {
			continue
		}
		if m.SupportedInAPI != nil && !*m.SupportedInAPI {
			continue
		}
		if _, ok := chatgptCompatibleCodexModels[m.Slug]; ok {
			result[m.Slug] = m.Slug
		}
	}

	// Always ensure gpt-5.5 is present during rollout
	result["gpt-5.5"] = "gpt-5.5"

	return result, nil
}
