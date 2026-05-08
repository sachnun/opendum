package providers

import (
	"context"
	"encoding/base64"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const imageFetchTimeout = 30 * time.Second
const maxImageFetchBytes = 20 << 20

func convertImageURLsToBase64(ctx context.Context, client *http.Client, messages []any) []any {
	if !hasExternalChatImageURL(messages) {
		return messages
	}
	out := make([]any, 0, len(messages))
	for _, raw := range messages {
		msg, ok := raw.(map[string]any)
		if !ok {
			out = append(out, raw)
			continue
		}
		content, ok := msg["content"].([]any)
		if !ok {
			out = append(out, msg)
			continue
		}
		copyMsg := cloneAnyMap(msg)
		parts := make([]any, 0, len(content))
		for _, rawPart := range content {
			part, ok := rawPart.(map[string]any)
			if !ok || part["type"] != "image_url" {
				parts = append(parts, rawPart)
				continue
			}
			copyPart := cloneAnyMap(part)
			imageURL, _ := copyPart["image_url"].(map[string]any)
			url := stringValue(imageURL["url"])
			if !isExternalURL(url) {
				parts = append(parts, copyPart)
				continue
			}
			if dataURI := fetchAsDataURI(ctx, client, url); dataURI != "" {
				imageURL["url"] = dataURI
			}
			parts = append(parts, copyPart)
		}
		copyMsg["content"] = parts
		out = append(out, copyMsg)
	}
	return out
}

func convertResponsesInputImageURLsToBase64(ctx context.Context, client *http.Client, input []any) []any {
	if !hasExternalResponsesImageURL(input) {
		return input
	}
	out := make([]any, 0, len(input))
	for _, raw := range input {
		item, ok := raw.(map[string]any)
		if !ok {
			out = append(out, raw)
			continue
		}
		content, ok := item["content"].([]any)
		if !ok {
			out = append(out, item)
			continue
		}
		copyItem := cloneAnyMap(item)
		parts := make([]any, 0, len(content))
		for _, rawPart := range content {
			part, ok := rawPart.(map[string]any)
			if !ok || part["type"] != "input_image" || !isExternalURL(stringValue(part["image_url"])) {
				parts = append(parts, rawPart)
				continue
			}
			copyPart := cloneAnyMap(part)
			if dataURI := fetchAsDataURI(ctx, client, stringValue(part["image_url"])); dataURI != "" {
				copyPart["image_url"] = dataURI
			}
			parts = append(parts, copyPart)
		}
		copyItem["content"] = parts
		out = append(out, copyItem)
	}
	return out
}

func hasExternalChatImageURL(messages []any) bool {
	for _, raw := range messages {
		msg, _ := raw.(map[string]any)
		content, _ := msg["content"].([]any)
		for _, rawPart := range content {
			part, _ := rawPart.(map[string]any)
			imageURL, _ := part["image_url"].(map[string]any)
			if part["type"] == "image_url" && isExternalURL(stringValue(imageURL["url"])) {
				return true
			}
		}
	}
	return false
}

func hasExternalResponsesImageURL(input []any) bool {
	for _, raw := range input {
		item, _ := raw.(map[string]any)
		content, _ := item["content"].([]any)
		for _, rawPart := range content {
			part, _ := rawPart.(map[string]any)
			if part["type"] == "input_image" && isExternalURL(stringValue(part["image_url"])) {
				return true
			}
		}
	}
	return false
}

func isExternalURL(value string) bool {
	return (strings.HasPrefix(value, "http://") || strings.HasPrefix(value, "https://")) && !strings.HasPrefix(value, "data:")
}

func isSafeExternalURL(value string) bool {
	parsed, err := url.Parse(value)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Hostname() == "" {
		return false
	}
	ips, err := net.LookupIP(parsed.Hostname())
	if err != nil || len(ips) == 0 {
		return false
	}
	for _, ip := range ips {
		if ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsMulticast() || ip.IsUnspecified() {
			return false
		}
	}
	return true
}

func fetchAsDataURI(ctx context.Context, client *http.Client, imageURL string) string {
	if !isSafeExternalURL(imageURL) {
		return ""
	}
	requestCtx, cancel := context.WithTimeout(ctx, imageFetchTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(requestCtx, http.MethodGet, imageURL, nil)
	if err != nil {
		return ""
	}
	resp, err := client.Do(req)
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return ""
	}
	contentType := strings.ToLower(strings.TrimSpace(strings.Split(resp.Header.Get("Content-Type"), ";")[0]))
	if contentType != "" && !strings.HasPrefix(contentType, "image/") && contentType != "application/pdf" {
		return ""
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxImageFetchBytes+1))
	if err != nil {
		return ""
	}
	if len(data) > maxImageFetchBytes {
		return ""
	}
	contentType = resp.Header.Get("Content-Type")
	if contentType == "" {
		contentType = "image/png"
	}
	return "data:" + contentType + ";base64," + base64.StdEncoding.EncodeToString(data)
}
