package registry

import (
	"embed"
	"io/fs"
)

//go:embed models/**/*.json models/*.json
var modelsFS embed.FS

// LoadEmbedded loads the model registry embedded directly into the binary.
func LoadEmbedded() (*Registry, error) {
	sub, err := fs.Sub(modelsFS, "models")
	if err != nil {
		return nil, err
	}
	return LoadFS(sub)
}
