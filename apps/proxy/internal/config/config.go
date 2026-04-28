package config

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"github.com/joho/godotenv"
)

type Config struct {
	Host             string
	Port             int
	DatabaseURL      string
	RedisURL         string
	BetterAuthSecret string
	ModelsDir        string
	ReadTimeout      time.Duration
	WriteTimeout     time.Duration
	IdleTimeout      time.Duration
}

func Load() (Config, error) {
	_ = godotenv.Load()
	_ = godotenv.Load("apps/proxy/.env")

	port, err := strconv.Atoi(getenv("PORT", "4001"))
	if err != nil || port <= 0 {
		return Config{}, fmt.Errorf("invalid PORT")
	}

	modelsDir, err := resolveModelsDir(os.Getenv("MODELS_DIR"))
	if err != nil {
		return Config{}, err
	}

	cfg := Config{
		Host:             getenv("HOST", "0.0.0.0"),
		Port:             port,
		DatabaseURL:      os.Getenv("DATABASE_URL"),
		RedisURL:         os.Getenv("REDIS_URL"),
		BetterAuthSecret: os.Getenv("BETTER_AUTH_SECRET"),
		ModelsDir:        modelsDir,
		ReadTimeout:      30 * time.Second,
		WriteTimeout:     0,
		IdleTimeout:      120 * time.Second,
	}

	if cfg.DatabaseURL == "" {
		return Config{}, errors.New("DATABASE_URL is required")
	}
	if cfg.RedisURL == "" {
		return Config{}, errors.New("REDIS_URL is required")
	}
	if cfg.BetterAuthSecret == "" {
		return Config{}, errors.New("BETTER_AUTH_SECRET is required")
	}

	return cfg, nil
}

func getenv(key, fallback string) string {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	return value
}

func resolveModelsDir(configured string) (string, error) {
	if configured != "" {
		return configured, nil
	}

	candidates := []string{
		"packages/models",
		"../../packages/models",
		"../../../packages/models",
	}

	if executable, err := os.Executable(); err == nil {
		execDir := filepath.Dir(executable)
		candidates = append(candidates,
			filepath.Join(execDir, "..", "packages", "models"),
			filepath.Join(execDir, "..", "..", "packages", "models"),
		)
	}

	for _, candidate := range candidates {
		if stat, err := os.Stat(candidate); err == nil && stat.IsDir() {
			return candidate, nil
		}
	}

	return "", errors.New("MODELS_DIR is required when packages/models cannot be auto-detected")
}
