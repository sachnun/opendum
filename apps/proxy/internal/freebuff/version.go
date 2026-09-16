package freebuff

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"sync/atomic"
	"time"
)

const (
	clientVersionFallback   = "0.0.175"
	npmRegistryLatestURL    = "https://registry.npmjs.org/freebuff/latest"
	clientVersionRefresh    = 30 * time.Minute
	clientVersionFetchLimit = 10 * time.Second
)

var clientVersion atomic.Value

// ClientUserAgent mirrors the user agent the real CLI sends on non-chat
// requests: "Freebuff-CLI/<published version>".
func ClientUserAgent() string {
	return "Freebuff-CLI/" + clientVersionString()
}

func clientVersionString() string {
	if version, ok := clientVersion.Load().(string); ok && strings.TrimSpace(version) != "" {
		return strings.TrimSpace(version)
	}
	return clientVersionFallback
}

// StartVersionRefresher tracks the published CLI version so upstream sees the
// same user agent as the real client.
func StartVersionRefresher(ctx context.Context) {
	go func() {
		refreshClientVersion(ctx)
		ticker := time.NewTicker(clientVersionRefresh)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				refreshClientVersion(ctx)
			}
		}
	}()
}

func refreshClientVersion(ctx context.Context) {
	fetchCtx, cancel := context.WithTimeout(ctx, clientVersionFetchLimit)
	defer cancel()
	req, err := http.NewRequestWithContext(fetchCtx, http.MethodGet, npmRegistryLatestURL, nil)
	if err != nil {
		return
	}
	req.Header.Set("Accept", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return
	}
	var parsed struct {
		Version string `json:"version"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
		return
	}
	if version := strings.TrimSpace(parsed.Version); version != "" {
		clientVersion.Store(version)
	}
}
