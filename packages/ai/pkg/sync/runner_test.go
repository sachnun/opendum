package sync

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRunRefreshPartialFailureWritesSummary(t *testing.T) {
	dir := t.TempDir()
	ok := FuncProvider("ok", func(_ context.Context, modelsDir string) (ProviderResult, error) {
		sub := filepath.Join(modelsDir, "test")
		if err := os.MkdirAll(sub, 0755); err != nil {
			return ProviderResult{}, err
		}
		content := []byte(`{"id":"m","providers":["ok"]}`)
		if err := os.WriteFile(filepath.Join(sub, "m.json"), content, 0644); err != nil {
			return ProviderResult{}, err
		}
		return ProviderResult{Provider: "ok"}, nil
	})
	bad := FuncProvider("bad", func(context.Context, string) (ProviderResult, error) {
		return ProviderResult{Provider: "bad"}, fmt.Errorf("boom")
	})

	summaryPath := filepath.Join(dir, "summary.md")
	err := RunRefresh(context.Background(), dir, []Provider{ok, bad}, summaryPath)
	if err == nil {
		t.Fatal("expected error when a provider fails")
	}
	if !strings.Contains(err.Error(), "bad") {
		t.Errorf("expected error to name failing provider, got: %v", err)
	}

	content, readErr := os.ReadFile(summaryPath)
	if readErr != nil {
		t.Fatalf("expected summary to be written despite failure: %v", readErr)
	}
	text := string(content)
	if !strings.Contains(text, "Failed providers") || !strings.Contains(text, "`bad`") {
		t.Errorf("summary missing failed-provider section: %s", text)
	}
	if !strings.Contains(text, "m") {
		t.Errorf("summary missing model added by successful provider: %s", text)
	}
}

func TestRunRefreshAllSucceedNoFailureSection(t *testing.T) {
	dir := t.TempDir()
	ok := FuncProvider("ok", func(context.Context, string) (ProviderResult, error) {
		return ProviderResult{Provider: "ok"}, nil
	})
	summaryPath := filepath.Join(dir, "summary.md")
	if err := RunRefresh(context.Background(), dir, []Provider{ok}, summaryPath); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	content, err := os.ReadFile(summaryPath)
	if err != nil {
		t.Fatalf("expected summary to be written: %v", err)
	}
	if strings.Contains(string(content), "Failed providers") {
		t.Errorf("summary should not mention failures: %s", content)
	}
}
