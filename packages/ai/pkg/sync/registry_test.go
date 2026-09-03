package sync

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestOrderProviders(t *testing.T) {
	got := OrderProviders([]string{"zenmux", "opencode", "openrouter"})
	if len(got) != 3 || got[0] != "opencode" || got[1] != "openrouter" || got[2] != "zenmux" {
		t.Fatalf("got %v", got)
	}
}

func TestInferModelFolder(t *testing.T) {
	if got := InferModelFolder("claude-opus-4-6"); got != "anthropic" {
		t.Errorf("got %q", got)
	}
	if got := InferModelFolder("gpt-4o"); got != "openai" {
		t.Errorf("got %q", got)
	}
	if got := InferModelFolder("some-unknown-model-xyz"); got != "" {
		t.Errorf("got %q", got)
	}
}

func TestWriteModelJSONOrdering(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "x.json")
	data := map[string]any{
		"providerConfig": map[string]any{
			"zenmux": map[string]any{"upstream": "a/b", "extra": 1},
			"codex":  map[string]any{"upstream": "x"},
		},
		"providers": []string{"zenmux", "opencode"},
		"family":    "Drop",
		"id":        "x",
	}
	if err := WriteModelJSON(path, data); err != nil {
		t.Fatal(err)
	}
	content, _ := os.ReadFile(path)
	s := string(content)
	if strings.Contains(s, "family") {
		t.Errorf("family should be deleted:\n%s", s)
	}
	idIdx := strings.Index(s, `"id"`)
	provIdx := strings.Index(s, `"providers"`)
	pcfgIdx := strings.Index(s, `"providerConfig"`)
	if !(idIdx < provIdx && provIdx < pcfgIdx) {
		t.Errorf("wrong key order:\n%s", s)
	}
	opencodeIdx := strings.Index(s, "opencode")
	zenmuxIdx := strings.Index(s, "zenmux")
	if !(opencodeIdx < zenmuxIdx) {
		t.Errorf("opencode should sort first:\n%s", s)
	}
	codexIdx := strings.Index(s, `"codex": {`)
	zenmuxKeyIdx := strings.Index(s, `"zenmux": {`)
	if !(codexIdx < zenmuxKeyIdx) {
		t.Errorf("provider map should be sorted:\n%s", s)
	}
	if !strings.HasSuffix(s, "}\n") {
		t.Errorf("should end with newline")
	}
}

func TestCollectModelFilesOneLevel(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "a.json"), []byte("{}"), 0644)
	os.MkdirAll(filepath.Join(dir, "sub", "deep"), 0755)
	os.WriteFile(filepath.Join(dir, "sub", "b.json"), []byte("{}"), 0644)
	os.WriteFile(filepath.Join(dir, "sub", "deep", "c.json"), []byte("{}"), 0644)
	files, err := CollectModelFiles(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 2 {
		t.Fatalf("expected 2 files (one level only), got %v", files)
	}
}

func TestGetProviderUpstream(t *testing.T) {
	data := map[string]any{
		"providerConfig": map[string]any{"openrouter": map[string]any{"upstream": "  foo/bar  "}},
	}
	if got := GetProviderUpstream(data, "openrouter", "fallback"); got != "foo/bar" {
		t.Errorf("got %q", got)
	}
	if got := GetProviderUpstream(map[string]any{}, "openrouter", "fallback"); got != "fallback" {
		t.Errorf("got %q", got)
	}
}
