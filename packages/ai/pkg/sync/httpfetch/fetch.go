package httpfetch

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

const MaxFetchAttempts = 3
const FetchTimeout = 20 * time.Second

func Sleep(ms int) {
	time.Sleep(time.Duration(ms) * time.Millisecond)
}

type Options struct {
	Attempts int
	Timeout  time.Duration
	Label    string
	Headers  map[string]string
}

func FetchJSON(ctx context.Context, client *http.Client, url string, target any, opt *Options) error {
	body, err := FetchBytes(ctx, client, url, "application/json", opt)
	if err != nil {
		return err
	}
	if err := json.Unmarshal(body, target); err != nil {
		return fmt.Errorf("decode %s: %w", labelOf(url, opt), err)
	}
	return nil
}

func FetchText(ctx context.Context, client *http.Client, url string, opt *Options) (string, error) {
	body, err := FetchBytes(ctx, client, url, "text/html", opt)
	if err != nil {
		return "", err
	}
	return string(body), nil
}

func FetchBytes(ctx context.Context, client *http.Client, url, accept string, opt *Options) ([]byte, error) {
	attempts := MaxFetchAttempts
	timeout := FetchTimeout
	label := url
	headers := map[string]string{}
	if opt != nil {
		if opt.Attempts > 0 {
			attempts = opt.Attempts
		}
		if opt.Timeout > 0 {
			timeout = opt.Timeout
		}
		if opt.Label != "" {
			label = opt.Label
		}
		for k, v := range opt.Headers {
			headers[k] = v
		}
	}
	if client == nil {
		client = &http.Client{Timeout: timeout}
	}

	var lastErr error
	for attempt := 1; attempt <= attempts; attempt++ {
		reqCtx, cancel := context.WithTimeout(ctx, timeout)
		req, err := http.NewRequestWithContext(reqCtx, "GET", url, nil)
		if err != nil {
			cancel()
			return nil, err
		}
		req.Header.Set("Accept", accept)
		for k, v := range headers {
			req.Header.Set(k, v)
		}
		resp, err := client.Do(req)
		if err != nil {
			cancel()
			lastErr = err
		} else {
			body, readErr := io.ReadAll(resp.Body)
			resp.Body.Close()
			cancel()
			if resp.StatusCode < 200 || resp.StatusCode >= 300 {
				lastErr = fmt.Errorf("Failed to fetch %s (%d %s)", label, resp.StatusCode, resp.Status)
			} else if readErr != nil {
				lastErr = readErr
			} else {
				return body, nil
			}
		}
		if attempt < attempts {
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(time.Duration(attempt) * time.Second):
			}
		}
	}
	if lastErr == nil {
		lastErr = fmt.Errorf("Failed to fetch %s", label)
	}
	return nil, lastErr
}

func labelOf(url string, opt *Options) string {
	if opt != nil && opt.Label != "" {
		return opt.Label
	}
	return url
}
