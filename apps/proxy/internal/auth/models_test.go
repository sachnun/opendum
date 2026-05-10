package auth

import (
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
