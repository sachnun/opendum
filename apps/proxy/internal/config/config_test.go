package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

var envKeys = []string{
	"PORT",
	"HOST",
	"DATABASE_URL",
	"REDIS_URL",
	"BETTER_AUTH_SECRET",
	"MODELS_DIR",
	"REQUEST_TIMEOUT_SECONDS",
	"TOKEN_REFRESH_INTERVAL_SECONDS",
	"PSIPHON_REGION",
}

func setEnv(t *testing.T, values map[string]string) {
	t.Helper()
	for _, key := range envKeys {
		t.Setenv(key, values[key])
	}
}

func TestLoadAppliesDefaults(t *testing.T) {
	setEnv(t, map[string]string{
		"DATABASE_URL":       "postgres://localhost/db",
		"REDIS_URL":          "redis://localhost:6379",
		"BETTER_AUTH_SECRET": "secret",
		"MODELS_DIR":         "/tmp/models",
	})

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Host != "0.0.0.0" {
		t.Errorf("Host = %q, want 0.0.0.0", cfg.Host)
	}
	if cfg.Port != 4001 {
		t.Errorf("Port = %d, want 4001", cfg.Port)
	}
	if cfg.ReadTimeout != 30*time.Second {
		t.Errorf("ReadTimeout = %v, want 30s", cfg.ReadTimeout)
	}
	if cfg.WriteTimeout != 0 {
		t.Errorf("WriteTimeout = %v, want 0", cfg.WriteTimeout)
	}
	if cfg.IdleTimeout != 120*time.Second {
		t.Errorf("IdleTimeout = %v, want 2m", cfg.IdleTimeout)
	}
	if cfg.RequestTimeout != 90*time.Second {
		t.Errorf("RequestTimeout = %v, want 90s", cfg.RequestTimeout)
	}
	if cfg.TokenRefreshInterval != 10*time.Minute {
		t.Errorf("TokenRefreshInterval = %v, want 10m", cfg.TokenRefreshInterval)
	}
	if cfg.ModelsDir != "/tmp/models" {
		t.Errorf("ModelsDir = %q, want /tmp/models", cfg.ModelsDir)
	}
	if cfg.PsiphonRegion != "US" {
		t.Errorf("PsiphonRegion = %q, want US", cfg.PsiphonRegion)
	}
}

func TestLoadReadsOverrides(t *testing.T) {
	setEnv(t, map[string]string{
		"PORT":                           "8080",
		"HOST":                           "127.0.0.1",
		"DATABASE_URL":                   "postgres://localhost/db",
		"REDIS_URL":                      "redis://localhost:6379",
		"BETTER_AUTH_SECRET":             "secret",
		"MODELS_DIR":                     "/tmp/models",
		"REQUEST_TIMEOUT_SECONDS":        "5",
		"TOKEN_REFRESH_INTERVAL_SECONDS": "60",
	})

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Port != 8080 || cfg.Host != "127.0.0.1" {
		t.Errorf("Host/Port = %q/%d, want 127.0.0.1/8080", cfg.Host, cfg.Port)
	}
	if cfg.RequestTimeout != 5*time.Second {
		t.Errorf("RequestTimeout = %v, want 5s", cfg.RequestTimeout)
	}
	if cfg.TokenRefreshInterval != time.Minute {
		t.Errorf("TokenRefreshInterval = %v, want 1m", cfg.TokenRefreshInterval)
	}
}

func TestLoadRejectsMissingRequired(t *testing.T) {
	cases := []struct {
		name    string
		missing string
		want    string
	}{
		{"database url", "DATABASE_URL", "DATABASE_URL"},
		{"redis url", "REDIS_URL", "REDIS_URL"},
		{"better auth secret", "BETTER_AUTH_SECRET", "BETTER_AUTH_SECRET"},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			values := map[string]string{
				"PORT":               "4001",
				"DATABASE_URL":       "postgres://localhost/db",
				"REDIS_URL":          "redis://localhost:6379",
				"BETTER_AUTH_SECRET": "secret",
				"MODELS_DIR":         "/tmp/models",
			}
			values[tc.missing] = ""
			setEnv(t, values)

			_, err := Load()
			if err == nil {
				t.Fatalf("Load() error = nil, want %s error", tc.want)
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("Load() error = %q, want substring %q", err, tc.want)
			}
		})
	}
}

func TestLoadRejectsInvalidPort(t *testing.T) {
	for _, port := range []string{"abc", "0", "-1", "1.5", " 4001"} {
		port := port
		t.Run(port, func(t *testing.T) {
			setEnv(t, map[string]string{
				"PORT":               port,
				"DATABASE_URL":       "postgres://localhost/db",
				"REDIS_URL":          "redis://localhost:6379",
				"BETTER_AUTH_SECRET": "secret",
				"MODELS_DIR":         "/tmp/models",
			})
			if _, err := Load(); err == nil {
				t.Fatalf("Load() with PORT=%q error = nil, want error", port)
			}
		})
	}
}

func TestDurationSeconds(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want time.Duration
	}{
		{"unset falls back", "", 45 * time.Second},
		{"valid seconds", "30", 30 * time.Second},
		{"zero allowed", "0", 0},
		{"negative falls back", "-5", 45 * time.Second},
		{"non numeric falls back", "abc", 45 * time.Second},
		{"whitespace falls back", " 30", 45 * time.Second},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("REQUEST_TIMEOUT_SECONDS", tc.raw)
			if got := durationSeconds("REQUEST_TIMEOUT_SECONDS", 45*time.Second); got != tc.want {
				t.Fatalf("durationSeconds = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestGetenv(t *testing.T) {
	t.Setenv("OPENDUM_TEST_KEY", "value")
	if got := getenv("OPENDUM_TEST_KEY", "fallback"); got != "value" {
		t.Fatalf("getenv = %q, want value", got)
	}
	t.Setenv("OPENDUM_TEST_KEY", "")
	if got := getenv("OPENDUM_TEST_KEY", "fallback"); got != "fallback" {
		t.Fatalf("getenv empty = %q, want fallback", got)
	}
}

func TestResolveModelsDirHonorsConfiguredPath(t *testing.T) {
	got, err := resolveModelsDir("/custom/models")
	if err != nil {
		t.Fatalf("resolveModelsDir: %v", err)
	}
	if got != "/custom/models" {
		t.Fatalf("resolveModelsDir = %q, want /custom/models", got)
	}
}

func TestResolveModelsDirAutoDetects(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "packages", "models", "data")
	if err := os.MkdirAll(target, 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	t.Chdir(root)

	got, err := resolveModelsDir("")
	if err != nil {
		t.Fatalf("resolveModelsDir: %v", err)
	}
	if got != filepath.Join("packages", "models", "data") {
		t.Fatalf("resolveModelsDir = %q, want packages/models/data", got)
	}
}

func TestResolveModelsDirFailsWhenNotFound(t *testing.T) {
	t.Chdir(t.TempDir())
	if _, err := resolveModelsDir(""); err == nil {
		t.Fatal("resolveModelsDir() error = nil, want error")
	}
}
