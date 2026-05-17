package proxy

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/opendum/opendum/apps/proxy/internal/auth"
	appdb "github.com/opendum/opendum/apps/proxy/internal/db"
	"github.com/opendum/opendum/apps/proxy/internal/models"
	"github.com/opendum/opendum/apps/proxy/internal/providers"
)

const (
	playgroundUserIDHeader    = "X-Opendum-Playground-User-Id"
	playgroundTimestampHeader = "X-Opendum-Playground-Timestamp"
	playgroundSignatureHeader = "X-Opendum-Playground-Signature"
	playgroundAuthWindow      = 2 * time.Minute
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

	authResult, playgroundAuth, err := s.authenticateRequest(ctx, r)
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

	forced, forceErr := s.validateForcedAccount(ctx, authResult.UserID, validation, parsed.ProviderAccountID, auth.AccountAccess{Mode: authResult.AccountAccessMode, Accounts: authResult.AccountAccessList}, playgroundAuth, cfg)
	if forceErr != nil {
		s.writeRouteError(w, cfg, forceErr.Status, forceErr.Message, forceErr.Type, forceErr.Param, forceErr.Code, forceErr.RetryAfter, forceErr.RetryAfterMS)
		return
	}

	account, providerResp, requestStartMS, upstreamFirstResponseMS, rotationFailures, roaming, errInfo := s.executeWithAccountRotation(ctx, r, cfg, parsed, authResult, validation, forced, startMS)
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
		if err := cfg.HandleStream(responseContext{Response: providerResp, AccountID: account.ID, Provider: account.Provider, Writer: w, Request: r, RequestStartMS: requestStartMS, UpstreamFirstResponseMS: upstreamFirstResponseMS, StartMS: startMS, UserID: authResult.UserID, APIKeyID: authResult.APIKeyID, Model: validation.Model}); err == nil {
			if roaming != nil {
				s.creditSharingPoint(context.Background(), account.UserID, roaming.DebitID, roaming.Amount)
			}
			go s.markAccountsRecoveredByRotation(context.Background(), rotationFailures)
		} else {
			if roaming != nil {
				s.refundRoamingPoint(context.Background(), roaming)
			}
			s.recordResponseHandlerFailure(context.Background(), account, validation.Model, authResult.UserID, authResult.APIKeyID, err, startMS)
		}
		return
	}

	if err := cfg.HandleNonStream(responseContext{Response: providerResp, AccountID: account.ID, Provider: account.Provider, Writer: w, Request: r, RequestStartMS: requestStartMS, UpstreamFirstResponseMS: upstreamFirstResponseMS, StartMS: startMS, UserID: authResult.UserID, APIKeyID: authResult.APIKeyID, Model: validation.Model}); err == nil {
		if roaming != nil {
			s.creditSharingPoint(context.Background(), account.UserID, roaming.DebitID, roaming.Amount)
		}
		go s.markAccountsRecoveredByRotation(context.Background(), rotationFailures)
	} else {
		if roaming != nil {
			s.refundRoamingPoint(context.Background(), roaming)
		}
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

func (s *Service) authenticateRequest(ctx context.Context, r *http.Request) (auth.Result, bool, error) {
	if result, ok := s.validatePlaygroundAuth(r); ok {
		return result, true, nil
	}

	authHeader := r.Header.Get("Authorization")
	if authHeader == "" {
		authHeader = r.Header.Get("X-Api-Key")
	}
	result, err := s.auth.ValidateAPIKey(ctx, authHeader)
	return result, false, err
}

func (s *Service) validatePlaygroundAuth(r *http.Request) (auth.Result, bool) {
	userID := strings.TrimSpace(r.Header.Get(playgroundUserIDHeader))
	timestampValue := strings.TrimSpace(r.Header.Get(playgroundTimestampHeader))
	signature := strings.TrimSpace(r.Header.Get(playgroundSignatureHeader))
	if userID == "" && timestampValue == "" && signature == "" {
		return auth.Result{}, false
	}
	if userID == "" || timestampValue == "" || signature == "" || strings.TrimSpace(s.secret) == "" {
		return auth.Result{Valid: false, Error: "Invalid playground session"}, true
	}

	timestamp, err := strconv.ParseInt(timestampValue, 10, 64)
	if err != nil {
		return auth.Result{Valid: false, Error: "Invalid playground session"}, true
	}
	requestTime := time.Unix(timestamp, 0)
	if time.Since(requestTime) > playgroundAuthWindow || time.Until(requestTime) > playgroundAuthWindow {
		return auth.Result{Valid: false, Error: "Invalid playground session"}, true
	}

	expectedSignature, err := hex.DecodeString(playgroundSignature(s.secret, userID, timestampValue, r.Method, r.URL.Path))
	providedSignature, decodeErr := hex.DecodeString(signature)
	if err != nil || decodeErr != nil || !hmac.Equal(providedSignature, expectedSignature) {
		return auth.Result{Valid: false, Error: "Invalid playground session"}, true
	}

	return auth.Result{
		Valid:             true,
		UserID:            userID,
		ModelAccessMode:   "all",
		AccountAccessMode: "all",
	}, true
}

func playgroundSignature(secret, userID, timestamp, method, path string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(userID + "\n" + timestamp + "\n" + method + "\n" + path))
	return hex.EncodeToString(mac.Sum(nil))
}

func (s *Service) makeProviderRequest(ctx context.Context, account appdb.ProviderAccount, payload map[string]any, stream bool) (*http.Response, error) {
	providerImpl, ok := s.providerRegistry.Get(account.Provider)
	if !ok {
		return nil, fmt.Errorf("provider %s is not implemented in Go proxy yet", account.Provider)
	}
	if isAuthlessProvider(providerImpl) || isSyntheticProviderAccountID(account.ID) {
		return providerImpl.MakeRequest(ctx, s.client, "", account, payload, stream)
	}
	credentials, requestAccount, err := s.credentialsForAccount(ctx, account, providerImpl)
	if err != nil {
		return nil, err
	}
	return providerImpl.MakeRequest(ctx, s.client, credentials, requestAccount, payload, stream)
}

func isAuthlessProvider(provider providers.Provider) bool {
	authless, ok := provider.(providers.AuthlessProvider)
	return ok && authless.Authless()
}
