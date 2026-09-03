package client_test

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/opendum/opendum/packages/ai/pkg/client"
	"github.com/opendum/opendum/packages/ai/pkg/protocol"
)

type roundTripFunc func(req *http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}

func TestClientChat(t *testing.T) {
	mockResponse := `{
		"id": "chatcmpl-test",
		"model": "gpt-4o",
		"choices": [
			{
				"message": {
					"role": "assistant",
					"content": "Hello world!",
					"reasoning_content": "Just saying hi"
				},
				"finish_reason": "stop"
			}
		],
		"usage": {
			"prompt_tokens": 10,
			"completion_tokens": 5,
			"total_tokens": 15
		}
	}`

	httpClient := &http.Client{
		Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			if req.Header.Get("Authorization") != "Bearer test-key" {
				t.Errorf("expected bearer token test-key")
			}
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     http.Header{"Content-Type": []string{"application/json"}},
				Body:       io.NopCloser(strings.NewReader(mockResponse)),
			}, nil
		}),
	}

	c := client.NewClient(client.Config{
		BaseURL:    "http://mock.opendum",
		APIKey:     "test-key",
		HTTPClient: httpClient,
	})

	resp, err := c.Chat(context.Background(), &protocol.CanonicalRequest{
		Model: "gpt-4o",
		Messages: []protocol.Message{
			{
				Role: protocol.RoleUser,
				Parts: []protocol.ContentPart{
					{
						Type: protocol.PartText,
						Text: "Hi",
					},
				},
			},
		},
	})

	if err != nil {
		t.Fatalf("client Chat failed: %v", err)
	}

	if resp.ID != "chatcmpl-test" {
		t.Errorf("expected id chatcmpl-test, got %s", resp.ID)
	}
	if resp.Content != "Hello world!" {
		t.Errorf("expected content Hello world!, got %s", resp.Content)
	}
	if resp.Thinking != "Just saying hi" {
		t.Errorf("expected thinking Just saying hi, got %s", resp.Thinking)
	}
	if resp.Usage.TotalTokens != 15 {
		t.Errorf("expected total tokens 15, got %d", resp.Usage.TotalTokens)
	}
}
