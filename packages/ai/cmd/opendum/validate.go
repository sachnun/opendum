package main

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/opendum/opendum/packages/ai/pkg/registry"
)

type aliasCollision struct {
	name   string
	models []string
}

func validateModels(modelsDir string) error {
	reg, err := registry.Load(modelsDir)
	if err != nil {
		return err
	}

	claims := map[string]map[string]bool{}
	var files int
	walkErr := filepath.WalkDir(modelsDir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || !strings.HasSuffix(d.Name(), ".json") {
			return nil
		}
		files++
		content, readErr := os.ReadFile(path)
		if readErr != nil {
			return readErr
		}
		var info registry.Info
		if unmarshalErr := json.Unmarshal(content, &info); unmarshalErr != nil {
			return fmt.Errorf("%s: %w", path, unmarshalErr)
		}
		if info.Ignored {
			return nil
		}

		fileID := strings.TrimSuffix(filepath.Base(path), ".json")
		modelID := strings.TrimSpace(info.ID)
		if modelID == "" {
			modelID = fileID
		}
		claim := func(name string) {
			if name == "" {
				return
			}
			if claims[name] == nil {
				claims[name] = map[string]bool{}
			}
			claims[name][modelID] = true
		}
		claim(modelID)
		if fileID != modelID {
			claim(fileID)
		}
		for _, alias := range info.Aliases {
			claim(strings.TrimSpace(alias))
		}
		return nil
	})
	if walkErr != nil {
		return walkErr
	}

	collisions := []aliasCollision{}
	for name, models := range claims {
		if len(models) < 2 {
			continue
		}
		ids := make([]string, 0, len(models))
		for id := range models {
			ids = append(ids, id)
		}
		sort.Strings(ids)
		collisions = append(collisions, aliasCollision{name: name, models: ids})
	}
	sort.Slice(collisions, func(i, j int) bool { return collisions[i].name < collisions[j].name })

	fmt.Printf("Validated %d model files (%d effective models).\n", files, len(reg.AllModels()))
	if len(collisions) > 0 {
		for _, c := range collisions {
			fmt.Fprintf(os.Stderr, "alias collision %q claimed by: %s\n", c.name, strings.Join(c.models, ", "))
		}
		return fmt.Errorf("%d alias collision(s) found", len(collisions))
	}
	return nil
}
