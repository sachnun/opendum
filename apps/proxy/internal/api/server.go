package api

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/cors"

	"github.com/opendum/opendum/apps/proxy/internal/auth"
	"github.com/opendum/opendum/apps/proxy/internal/models"
	"github.com/opendum/opendum/apps/proxy/internal/proxy"
)

type Server struct {
	registry *models.Registry
	auth     *auth.Service
	proxy    *proxy.Service
	secret   string
}

func NewServer(registry *models.Registry, authSvc *auth.Service, proxySvc *proxy.Service, secret string) http.Handler {
	s := &Server{registry: registry, auth: authSvc, proxy: proxySvc, secret: secret}
	r := chi.NewRouter()
	r.Use(cors.Handler(cors.Options{
		AllowedOrigins:   []string{"*"},
		AllowedMethods:   []string{"GET", "POST", "OPTIONS"},
		AllowedHeaders:   []string{"*"},
		ExposedHeaders:   []string{"*"},
		AllowCredentials: true,
	}))

	r.Get("/", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/v1", http.StatusPermanentRedirect)
	})
	r.Get("/v1", func(w http.ResponseWriter, _ *http.Request) {
		WriteOpenAIError(w, http.StatusNotFound, ErrorInfo{Message: "Unknown API endpoint.", Type: "invalid_request_error"})
	})
	r.Get("/v1/models", s.modelsRoute)
	r.Post("/v1/chat/completions", s.proxy.ChatCompletions)
	r.Post("/v1/messages", s.proxy.Messages)
	r.Post("/v1/responses", s.proxy.Responses)
	r.Post("/internal/refresh", s.internalRefreshRoute)
	r.Post("/internal/quota", s.proxy.InternalQuota)
	r.NotFound(func(w http.ResponseWriter, r *http.Request) {
		if len(r.URL.Path) >= 4 && r.URL.Path[:4] == "/v1" {
			WriteOpenAIError(w, http.StatusNotFound, ErrorInfo{Message: "Unknown API endpoint.", Type: "invalid_request_error"})
			return
		}
		WriteOpenAIError(w, http.StatusNotFound, ErrorInfo{Message: "Not Found", Type: "invalid_request_error"})
	})
	return r
}

func (s *Server) validateInternalSignature(r *http.Request, path string, body []byte) bool {
	if strings.TrimSpace(s.secret) == "" {
		return false
	}
	timestampValue := strings.TrimSpace(r.Header.Get("X-Opendum-Internal-Timestamp"))
	signatureValue := strings.TrimSpace(r.Header.Get("X-Opendum-Internal-Signature"))
	if timestampValue == "" || signatureValue == "" {
		return false
	}
	timestamp, err := strconv.ParseInt(timestampValue, 10, 64)
	if err != nil {
		return false
	}
	requestTime := time.Unix(timestamp, 0)
	if time.Since(requestTime) > 2*time.Minute || time.Until(requestTime) > 2*time.Minute {
		return false
	}
	provided, err := hex.DecodeString(signatureValue)
	if err != nil {
		return false
	}
	mac := hmac.New(sha256.New, []byte(s.secret))
	_, _ = mac.Write([]byte(timestampValue))
	_, _ = mac.Write([]byte("\n"))
	_, _ = mac.Write([]byte(path))
	_, _ = mac.Write([]byte("\n"))
	_, _ = mac.Write(body)
	expected := mac.Sum(nil)
	return hmac.Equal(provided, expected)
}

func (s *Server) modelsRoute(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	authHeader := r.Header.Get("Authorization")
	if authHeader == "" {
		authHeader = r.Header.Get("X-Api-Key")
	}

	var userID string
	apiKeyModelAccessMode := "all"
	roamingEnabled := false
	apiKeyModelSet := map[string]struct{}{}
	if authHeader != "" {
		result, err := s.auth.ValidateAPIKey(ctx, authHeader)
		if err != nil {
			WriteOpenAIError(w, http.StatusInternalServerError, ErrorInfo{Message: "Internal server error.", Type: "api_error"})
			return
		}
		if !result.Valid {
			WriteOpenAIError(w, http.StatusUnauthorized, ErrorInfo{Message: result.Error, Type: "authentication_error"})
			return
		}
		userID = result.UserID
		apiKeyModelAccessMode = result.ModelAccessMode
		roamingEnabled = result.RoamingEnabled
		for _, model := range result.ModelAccessList {
			apiKeyModelSet[s.registry.ResolveAlias(model)] = struct{}{}
		}
	}

	allModels := s.registry.FormatModelsForOpenAI()
	if userID == "" {
		writeJSON(w, http.StatusOK, map[string]any{"object": "list", "data": allModels})
		return
	}

	disabledSet, err := s.auth.DisabledModelSetForUser(ctx, userID)
	if err != nil {
		WriteOpenAIError(w, http.StatusInternalServerError, ErrorInfo{Message: "Internal server error.", Type: "api_error"})
		return
	}
	availability, err := s.auth.GetAccountModelAvailabilityWithSharing(ctx, userID, roamingEnabled)
	if err != nil {
		WriteOpenAIError(w, http.StatusInternalServerError, ErrorInfo{Message: "Internal server error.", Type: "api_error"})
		return
	}

	enabled := make([]map[string]any, 0, len(allModels))
	for _, item := range allModels {
		id, _ := item["id"].(string)
		canonical := s.registry.ResolveAlias(id)
		if _, disabled := disabledSet[canonical]; disabled {
			continue
		}
		if !s.auth.IsModelUsableByAccounts(canonical, availability) && !(roamingEnabled && s.auth.IsModelUsableBySharedAccounts(canonical, availability)) {
			continue
		}
		if apiKeyModelAccessMode == "whitelist" {
			if _, ok := apiKeyModelSet[canonical]; !ok {
				continue
			}
		}
		if apiKeyModelAccessMode == "blacklist" {
			if _, ok := apiKeyModelSet[canonical]; ok {
				continue
			}
		}
		enabled = append(enabled, item)
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"object": "list", "data": enabled})
}
