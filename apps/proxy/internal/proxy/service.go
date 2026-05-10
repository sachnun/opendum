package proxy

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/opendum/opendum/apps/proxy/internal/auth"
	"github.com/opendum/opendum/apps/proxy/internal/cryptojs"
	appdb "github.com/opendum/opendum/apps/proxy/internal/db"
	"github.com/opendum/opendum/apps/proxy/internal/models"
	"github.com/opendum/opendum/apps/proxy/internal/providers"
)

type Service struct {
	db               *appdb.DB
	redis            *redis.Client
	auth             *auth.Service
	registry         *models.Registry
	providerRegistry *providers.Registry
	secret           string
	client           *http.Client
}

func NewService(db *appdb.DB, redisClient *redis.Client, authSvc *auth.Service, registry *models.Registry, secret string) *Service {
	return &Service{
		db:               db,
		redis:            redisClient,
		auth:             authSvc,
		registry:         registry,
		providerRegistry: providers.NewRegistry(registry, db, redisClient),
		secret:           secret,
		client:           &http.Client{Timeout: 0},
	}
}

func (s *Service) ChatCompletions(w http.ResponseWriter, r *http.Request) {
	s.handle(w, r, chatCompletionsConfig(s))
}

func (s *Service) Responses(w http.ResponseWriter, r *http.Request) {
	s.handle(w, r, responsesConfig(s))
}

func (s *Service) Messages(w http.ResponseWriter, r *http.Request) {
	s.handle(w, r, messagesConfig(s))
}

func (s *Service) handle(w http.ResponseWriter, r *http.Request, cfg endpointAdapter) {
	startMS := time.Now().UnixMilli()
	ctx := r.Context()

	authHeader := r.Header.Get("Authorization")
	if authHeader == "" {
		authHeader = r.Header.Get("X-Api-Key")
	}
	authResult, err := s.auth.ValidateAPIKey(ctx, authHeader)
	if err != nil {
		s.writeRouteError(w, cfg, http.StatusInternalServerError, "Internal server error", "api_error", nil, nil, nil, nil)
		return
	}
	if !authResult.Valid {
		s.writeRouteError(w, cfg, http.StatusUnauthorized, authResult.Error, "authentication_error", nil, nil, nil, nil)
		return
	}

	var body map[string]any
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body == nil {
		s.writeRouteError(w, cfg, http.StatusBadRequest, "Invalid JSON in request body", "invalid_request_error", nil, nil, nil, nil)
		return
	}

	parsed, routeErr := cfg.Parse(body)
	if routeErr != nil {
		s.writeRouteError(w, cfg, routeErr.Status, routeErr.Message, routeErr.Type, routeErr.Param, routeErr.Code, routeErr.RetryAfter, routeErr.RetryAfterMS)
		return
	}
	r = r.WithContext(context.WithValue(ctx, requestBodyContextKey{}, body))
	ctx = r.Context()

	validation, err := s.auth.ValidateModelForUser(ctx, authResult.UserID, parsed.ModelParam, auth.ModelAccess{Mode: authResult.ModelAccessMode, Models: authResult.ModelAccessList})
	if err != nil {
		s.writeRouteError(w, cfg, http.StatusInternalServerError, "Internal server error", "api_error", nil, nil, nil, nil)
		return
	}
	if !validation.Valid {
		s.writeRouteError(w, cfg, http.StatusBadRequest, validation.Error, "invalid_request_error", ptrIfNotEmpty(validation.Param), ptrIfNotEmpty(validation.Code), nil, nil)
		return
	}

	if authResult.APIKeyID != "" && len(authResult.RateLimitRules) > 0 {
		rl, err := s.checkAndIncrementAPIKeyRateLimit(ctx, authResult.APIKeyID, validation.Model, authResult.RateLimitRules)
		if err != nil {
			s.writeRouteError(w, cfg, http.StatusInternalServerError, "Internal server error", "api_error", nil, nil, nil, nil)
			return
		}
		if !rl.Allowed {
			if rl.RetryAfterSeconds > 0 {
				w.Header().Set("Retry-After", fmt.Sprint(rl.RetryAfterSeconds))
			}
			message := fmt.Sprintf("Rate limit exceeded for %s: %d/%d requests per %s. Retry after %ds.", validation.Model, rl.Current, rl.Limit, rl.ExceededWindow, rl.RetryAfterSeconds)
			retryAfter, retryAfterMS := retryMetadata(time.Duration(rl.RetryAfterSeconds) * time.Second)
			s.writeRouteError(w, cfg, cfg.RateLimitStatusCode, message, "rate_limit_error", nil, nil, retryAfter, retryAfterMS)
			return
		}
	}

	forced, forceErr := s.validateForcedAccount(ctx, authResult.UserID, validation, parsed.ProviderAccountID, auth.AccountAccess{Mode: authResult.AccountAccessMode, Accounts: authResult.AccountAccessList}, cfg)
	if forceErr != nil {
		s.writeRouteError(w, cfg, forceErr.Status, forceErr.Message, forceErr.Type, forceErr.Param, forceErr.Code, forceErr.RetryAfter, forceErr.RetryAfterMS)
		return
	}

	account, providerResp, requestStartMS, rotationFailures, errInfo := s.executeWithAccountRotation(ctx, r, cfg, parsed, authResult, validation, forced, startMS)
	if errInfo != nil {
		s.writeRouteError(w, cfg, errInfo.Status, errInfo.Message, errInfo.Type, errInfo.Param, errInfo.Code, errInfo.RetryAfter, errInfo.RetryAfterMS)
		return
	}
	if account == nil || providerResp == nil {
		s.writeRouteError(w, cfg, http.StatusServiceUnavailable, "No available accounts for this request.", "api_error", nil, nil, nil, nil)
		return
	}
	defer providerResp.Body.Close()

	if parsed.Stream {
		if err := cfg.HandleStream(responseContext{Response: providerResp, AccountID: account.ID, Provider: account.Provider, Writer: w, Request: r, RequestStartMS: requestStartMS, StartMS: startMS, UserID: authResult.UserID, APIKeyID: authResult.APIKeyID, Model: validation.Model}); err == nil {
			go s.markAccountsRecoveredByRotation(context.Background(), rotationFailures)
		} else {
			s.recordResponseHandlerFailure(context.Background(), account, validation.Model, authResult.UserID, authResult.APIKeyID, err, startMS)
		}
		return
	}

	if err := cfg.HandleNonStream(responseContext{Response: providerResp, AccountID: account.ID, Provider: account.Provider, Writer: w, Request: r, RequestStartMS: requestStartMS, StartMS: startMS, UserID: authResult.UserID, APIKeyID: authResult.APIKeyID, Model: validation.Model}); err == nil {
		go s.markAccountsRecoveredByRotation(context.Background(), rotationFailures)
	} else {
		s.recordResponseHandlerFailure(context.Background(), account, validation.Model, authResult.UserID, authResult.APIKeyID, err, startMS)
	}
}

func (s *Service) recordResponseHandlerFailure(ctx context.Context, account *appdb.ProviderAccount, model, userID, apiKeyID string, err error, startMS int64) {
	if account == nil || err == nil {
		return
	}
	message := err.Error()
	s.markAccountFailed(ctx, account.ID, model, http.StatusInternalServerError, message)
	s.logUsage(ctx, usageParams{UserID: userID, ProviderAccountID: account.ID, ProxyAPIKeyID: apiKeyID, Model: model, StatusCode: http.StatusInternalServerError, DurationMS: int(time.Now().UnixMilli() - startMS), Provider: account.Provider})
}

func (s *Service) makeProviderRequest(ctx context.Context, account appdb.ProviderAccount, payload map[string]any, stream bool) (*http.Response, error) {
	providerImpl, ok := s.providerRegistry.Get(account.Provider)
	if !ok {
		return nil, fmt.Errorf("provider %s is not implemented in Go proxy yet", account.Provider)
	}
	requestAccount := account
	if requestAccount.AccessToken == "" || requestAccount.RefreshToken == "" {
		if err := s.db.NewSelect().Model(&requestAccount).Column("id", "provider", "accessToken", "refreshToken", "expiresAt", "accountId", "projectId", "tier", "email").Where("id = ?", account.ID).Limit(1).Scan(ctx); err != nil {
			return nil, err
		}
	}
	credentials, err := cryptojs.Decrypt(s.secret, requestAccount.AccessToken)
	if err != nil {
		return nil, err
	}
	refreshBuffer := 3 * time.Hour
	if customBuffer, ok := providerImpl.(providers.RefreshBufferProvider); ok {
		refreshBuffer = customBuffer.RefreshBuffer()
	}
	if refresher, ok := providerImpl.(providers.CredentialRefresher); ok && time.Now().After(requestAccount.ExpiresAt.Add(-refreshBuffer)) {
		refreshToken, err := cryptojs.Decrypt(s.secret, requestAccount.RefreshToken)
		if err != nil {
			return nil, err
		}
		refreshed, err := refresher.RefreshCredentials(ctx, s.client, refreshToken, requestAccount)
		if err != nil {
			if time.Now().After(requestAccount.ExpiresAt) {
				return nil, err
			}
		} else {
			encryptedAccess, err := cryptojs.Encrypt(s.secret, refreshed.AccessToken)
			if err != nil {
				return nil, err
			}
			encryptedRefresh, err := cryptojs.Encrypt(s.secret, refreshed.RefreshToken)
			if err != nil {
				return nil, err
			}
			query := s.db.NewUpdate().Model((*appdb.ProviderAccount)(nil)).Set("\"accessToken\" = ?", encryptedAccess).Set("\"refreshToken\" = ?", encryptedRefresh).Set("\"expiresAt\" = ?", refreshed.ExpiresAt).Where("id = ?", requestAccount.ID)
			if refreshed.ProjectID != "" {
				query.Set("\"projectId\" = ?", refreshed.ProjectID)
				requestAccount.ProjectID = &refreshed.ProjectID
			}
			if refreshed.Tier != "" {
				query.Set("tier = ?", refreshed.Tier)
				requestAccount.Tier = &refreshed.Tier
			}
			if refreshed.Email != "" {
				query.Set("email = ?", refreshed.Email)
				requestAccount.Email = &refreshed.Email
			}
			if refreshed.AccountID != "" {
				query.Set("\"accountId\" = ?", refreshed.AccountID)
				requestAccount.AccountID = &refreshed.AccountID
			}
			_, _ = query.Exec(ctx)
			credentials = refreshed.AccessToken
		}
	}
	return providerImpl.MakeRequest(ctx, s.client, credentials, requestAccount, payload, stream)
}
