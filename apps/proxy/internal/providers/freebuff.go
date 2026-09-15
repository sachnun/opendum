package providers

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/redis/go-redis/v9"

	appdb "github.com/opendum/opendum/apps/proxy/internal/db"
	"github.com/opendum/opendum/apps/proxy/internal/freebuff"
	"github.com/opendum/opendum/apps/proxy/internal/models"
)

const (
	freebuffProviderName = "freebuff"
	freebuffAPIBaseURL   = "https://www.codebuff.com"
)

type freebuffProvider struct {
	registry *models.Registry
	client   *freebuff.Client
	manager  *freebuff.Manager
}

func newFreebuffProvider(registry *models.Registry, redisClient *redis.Client) freebuffProvider {
	client := freebuff.NewClient(freebuffAPIBaseURL)
	return freebuffProvider{registry: registry, client: client, manager: freebuff.NewManager(client, redisClient)}
}

func (p freebuffProvider) MakeRequest(ctx context.Context, _ *http.Client, credentials string, account appdb.ProviderAccount, body map[string]any, stream bool) (*http.Response, error) {
	model := strings.TrimPrefix(strings.TrimSpace(stringValue(body["model"])), freebuffProviderName+"/")
	upstream := model
	agent := ""
	if p.registry != nil {
		model = p.registry.ResolveAlias(model)
		upstream = p.registry.UpstreamModelName(model, freebuffProviderName)
		agent = providerConfigString(p.registry, model, freebuffProviderName, "agent")
	}
	token := strings.TrimSpace(credentials)
	if token == "" {
		return nil, fmt.Errorf("freebuff: missing auth token")
	}
	if strings.TrimSpace(agent) == "" {
		return nil, fmt.Errorf("freebuff: model %q has no agent mapping", model)
	}
	userID := ""
	if account.AccountID != nil {
		userID = strings.TrimSpace(*account.AccountID)
	}

	for attempt := 0; ; attempt++ {
		lease, err := p.manager.Prepare(ctx, account.ID, token, userID, agent, upstream)
		if err != nil {
			if apiErr, ok := freebuff.Classify(err); ok {
				return freebuff.NewResponse(apiErr.Status, apiErr.Message, apiErr.RetryAfter), nil
			}
			return nil, err
		}
		upstreamBody, err := freebuff.BuildChatBody(body, upstream, lease.RunID, lease.InstanceID, lease.ClientID, lease.Step)
		if err != nil {
			lease.Release()
			return nil, err
		}
		resp, errorBody, err := p.client.Chat(ctx, token, userID, upstreamBody)
		if err != nil {
			lease.Release()
			return nil, err
		}
		if resp.StatusCode >= 200 && resp.StatusCode < 300 {
			resp.Body = freebuff.WrapBody(resp.Body, lease)
			return resp, nil
		}
		if attempt == 0 && freebuff.IsSessionInvalid(resp.StatusCode, errorBody) {
			lease.Release()
			p.manager.InvalidateSession(account.ID)
			continue
		}
		lease.Release()
		resp.Body = io.NopCloser(bytes.NewReader(errorBody))
		return resp, nil
	}
}
