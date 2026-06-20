package auth

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

	"github.com/opendum/opendum/apps/proxy/internal/models"
)

func TestValidateModelRejectsCodexChatGPTIncompatibleModel(t *testing.T) {
	registry, err := models.Load(filepath.Join("..", "..", "..", "..", "models"))
	if err != nil {
		t.Fatalf("load registry: %v", err)
	}
	service := NewService(nil, nil, registry)

	result := service.ValidateModel("codex/gpt-5.1-codex")
	if result.Valid {
		t.Fatal("ValidateModel returned valid result")
	}
	if result.Code != "unsupported_codex_chatgpt_model" || result.Param != "model" {
		t.Fatalf("result = %+v", result)
	}
	if !strings.Contains(result.Error, "not supported for Codex when using a ChatGPT account") || !strings.Contains(result.Error, "gpt-5.5") {
		t.Fatalf("error = %q", result.Error)
	}
}

func TestValidateModelAcceptsCodexChatGPTCompatibleModel(t *testing.T) {
	registry, err := models.Load(filepath.Join("..", "..", "..", "..", "models"))
	if err != nil {
		t.Fatalf("load registry: %v", err)
	}
	service := NewService(nil, nil, registry)

	result := service.ValidateModel("codex/gpt-5.5")
	if !result.Valid {
		t.Fatalf("ValidateModel returned invalid result: %+v", result)
	}
	if result.Provider == nil || *result.Provider != "codex" || result.Model != "gpt-5.5" {
		t.Fatalf("result = %+v", result)
	}
}

func TestValidateModelSuggestsSimilarModels(t *testing.T) {
	registry, err := models.Load(filepath.Join("..", "..", "..", "..", "models"))
	if err != nil {
		t.Fatalf("load registry: %v", err)
	}
	service := NewService(nil, nil, registry)

	result := service.ValidateModel("gemini-2.5-flas")
	if result.Valid {
		t.Fatal("ValidateModel returned valid result")
	}
	if result.Code != "invalid_model" || result.Param != "model" {
		t.Fatalf("result = %+v", result)
	}
	if !strings.Contains(result.Error, "Did you mean:") || !strings.Contains(result.Error, "gemini-2.5-flash") {
		t.Fatalf("error = %q", result.Error)
	}
}

func TestValidateModelSuggestionsExcludeAliases(t *testing.T) {
	registry, err := models.Load(filepath.Join("..", "..", "..", "..", "models"))
	if err != nil {
		t.Fatalf("load registry: %v", err)
	}
	service := NewService(nil, nil, registry)

	result := service.ValidateModel("mistral-large-3-675b-instruct-25122")
	if result.Valid {
		t.Fatal("ValidateModel returned valid result")
	}
	if !strings.Contains(result.Error, "Did you mean:") || !strings.Contains(result.Error, "mistral-large-3") {
		t.Fatalf("error = %q", result.Error)
	}
	suggestions := strings.TrimPrefix(result.Error[strings.Index(result.Error, "Did you mean: "):], "Did you mean: ")
	if strings.Contains(suggestions, "mistral-large-3-675b-instruct-2512") || strings.Contains(suggestions, "mistralai/mistral-large") {
		t.Fatalf("alias was suggested: %q", result.Error)
	}
}

func TestValidateModelSuggestsFromTokenTypos(t *testing.T) {
	registry, err := models.Load(filepath.Join("..", "..", "..", "..", "models"))
	if err != nil {
		t.Fatalf("load registry: %v", err)
	}
	service := NewService(nil, nil, registry)

	result := service.ValidateModel("clod opua 46")
	if result.Valid {
		t.Fatal("ValidateModel returned valid result")
	}
	if !strings.Contains(result.Error, "Did you mean:") || !strings.Contains(result.Error, "claude-opus-4-6") {
		t.Fatalf("error = %q", result.Error)
	}
}

func TestValidateModelForUserHidesAPIKeyModelAccessDenials(t *testing.T) {
	registry, err := models.Load(filepath.Join("..", "..", "..", "..", "models"))
	if err != nil {
		t.Fatalf("load registry: %v", err)
	}
	service := NewService(nil, nil, registry)

	tests := []struct {
		name       string
		access     ModelAccess
		wantModel  string
		notContain string
	}{
		{name: "whitelist", access: ModelAccess{Mode: "whitelist", Models: []string{"gemini-2.5-flash-lite"}}, wantModel: "gemini-2.5-flash-lite"},
		{name: "blacklist", access: ModelAccess{Mode: "blacklist", Models: []string{"gemini-2.5-flash"}}, wantModel: "gemini-2.5-flash-lite", notContain: "Did you mean: gemini-2.5-flash ?"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result, err := service.ValidateModelForUser(context.Background(), "user_1", "gemini-2.5-flash", tt.access)
			if err != nil {
				t.Fatalf("ValidateModelForUser error: %v", err)
			}
			if result.Valid {
				t.Fatal("ValidateModelForUser returned valid result")
			}
			if result.Code != "invalid_model" || result.Param != "model" {
				t.Fatalf("result = %+v", result)
			}
			if !strings.Contains(result.Error, "Did you mean:") || !strings.Contains(result.Error, tt.wantModel) {
				t.Fatalf("error = %q", result.Error)
			}
			if tt.notContain != "" && strings.Contains(result.Error, tt.notContain) {
				t.Fatalf("error = %q", result.Error)
			}
		})
	}
}

func TestValidateModelForUserDoesNotSuggestWhenNoUsableCandidates(t *testing.T) {
	registry, err := models.Load(filepath.Join("..", "..", "..", "..", "models"))
	if err != nil {
		t.Fatalf("load registry: %v", err)
	}
	service := NewService(nil, nil, registry)

	result, err := service.ValidateModelForUser(context.Background(), "user_1", "clod opus 4.6", ModelAccess{Mode: "whitelist", Models: []string{"gemini-2.5-flash-lite"}})
	if err != nil {
		t.Fatalf("ValidateModelForUser error: %v", err)
	}
	if result.Valid {
		t.Fatal("ValidateModelForUser returned valid result")
	}
	if strings.Contains(result.Error, "claude-opus-4-6") || strings.Contains(result.Error, "Did you mean:") {
		t.Fatalf("unexpected suggestion = %q", result.Error)
	}
	if !strings.Contains(result.Error, "Use GET /v1/models") {
		t.Fatalf("error = %q", result.Error)
	}
}
