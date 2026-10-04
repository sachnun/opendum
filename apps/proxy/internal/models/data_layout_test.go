package models

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func repoPath(parts ...string) string {
	return filepath.Join(append([]string{"..", "..", "..", ".."}, parts...)...)
}

func countModelFiles(t *testing.T, dir string) int {
	t.Helper()
	count := 0
	err := filepath.WalkDir(dir, func(_ string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".json") {
			count++
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk %s: %v", dir, err)
	}
	return count
}

func TestProxyImageShipsEveryModelDirectory(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "Dockerfile"))
	if err != nil {
		t.Fatalf("read proxy Dockerfile: %v", err)
	}
	dockerfile := string(raw)
	finalStage := dockerfile[strings.LastIndex(dockerfile, "FROM"):]

	root := repoPath("packages", "models")
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatalf("read %s: %v", root, err)
	}

	checked := 0
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		if countModelFiles(t, filepath.Join(root, entry.Name())) == 0 {
			continue
		}
		checked++
		want := filepath.ToSlash(filepath.Join("packages", "models", entry.Name()))
		if !strings.Contains(finalStage, want) {
			t.Errorf("final image stage never copies %s, so the runtime registry loses that data", want)
		}
	}

	if checked == 0 {
		t.Fatalf("found no model directory under %s", root)
	}
}

func TestRegistryReadsGeneratedSibling(t *testing.T) {
	modelsDir := repoPath("packages", "models", "data")
	generatedDir := resolveGeneratedDir(modelsDir)

	if filepath.Dir(generatedDir) != filepath.Dir(modelsDir) {
		t.Fatalf("generated dir %q is not a sibling of %q", generatedDir, modelsDir)
	}
	if countModelFiles(t, generatedDir) == 0 {
		t.Fatalf("no model files under %s", generatedDir)
	}

	registry, err := Load(modelsDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(registry.AllModels()) == 0 {
		t.Fatalf("no servable model loaded from %s, so %s was not applied", modelsDir, generatedDir)
	}
}
