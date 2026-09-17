package proxy

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/opendum/opendum/apps/proxy/internal/models"
)

const (
	mockFamilyModel = "mock-family-model"
	mockPlainModel  = "mock-plain-model"
	mockPricedModel = "mock-priced-model"
	mockProvider    = "mockprov"
)

func mockRegistry(t *testing.T) *models.Registry {
	t.Helper()
	dir := t.TempDir()
	writeMockModel(t, dir, mockFamilyModel, map[string]any{
		"providers": []string{mockProvider},
		"family":    "mock-family",
	})
	writeMockModel(t, dir, mockPlainModel, map[string]any{
		"providers": []string{mockProvider},
	})
	writeMockModel(t, dir, mockPricedModel, map[string]any{
		"providers": []string{mockProvider},
		"cost": map[string]any{
			"input":      10.0,
			"output":     50.0,
			"cacheRead":  1.0,
			"cacheWrite": 12.5,
		},
	})
	registry, err := models.Load(dir)
	if err != nil {
		t.Fatalf("load mock registry: %v", err)
	}
	return registry
}

func writeMockModel(t *testing.T, dir, name string, body map[string]any) {
	t.Helper()
	data, err := json.MarshalIndent(body, "", "  ")
	if err != nil {
		t.Fatalf("marshal mock model %s: %v", name, err)
	}
	if err := os.WriteFile(filepath.Join(dir, name+".json"), data, 0o644); err != nil {
		t.Fatalf("write mock model %s: %v", name, err)
	}
}
