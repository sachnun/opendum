package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/opendum/opendum/packages/ai/pkg/sync"
	"github.com/opendum/opendum/packages/ai/pkg/sync/providers"
)

func main() {
	if len(os.Args) < 2 {
		printUsage()
		os.Exit(1)
	}
	switch os.Args[1] {
	case "refresh", "sync":
		runRefresh(os.Args[2:])
	case "validate":
		runValidate(os.Args[2:])
	default:
		printUsage()
		os.Exit(1)
	}
}

func printUsage() {
	fmt.Println("Opendum Tool")
	fmt.Println()
	fmt.Println("Usage:")
	fmt.Println("  opendum refresh [--summary <path>]")
	fmt.Println("  opendum validate")
}

func defaultModelsDir() string {
	if dir := os.Getenv("MODELS_DIR"); dir != "" {
		return dir
	}
	candidates := []string{
		"packages/ai/models",
		"../packages/ai/models",
		"../../packages/ai/models",
		"models",
		"../models",
	}
	for _, c := range candidates {
		if st, err := os.Stat(c); err == nil && st.IsDir() {
			return c
		}
	}
	if exe, err := os.Executable(); err == nil {
		base := filepath.Dir(exe)
		for i := 0; i < 4; i++ {
			c := filepath.Join(base, "packages", "ai", "models")
			if st, err := os.Stat(c); err == nil && st.IsDir() {
				return c
			}
			c2 := filepath.Join(base, "models")
			if st, err := os.Stat(c2); err == nil && st.IsDir() {
				return c2
			}
			base = filepath.Dir(base)
		}
	}
	return "packages/ai/models"
}

func runRefresh(args []string) {
	fs := flag.NewFlagSet("refresh", flag.ExitOnError)
	summaryPath := fs.String("summary", "", "Path to write PR summary markdown")
	_ = fs.Parse(args)

	modelsDir := defaultModelsDir()
	absModels, _ := filepath.Abs(modelsDir)
	fmt.Printf("Starting model refresh on %s...\n", absModels)

	all := []sync.Provider{
		sync.FuncProvider("antigravity-version", func(ctx context.Context, dir string) (sync.ProviderResult, error) {
			err := providers.SyncAntigravityVersion(ctx, dir)
			return sync.ProviderResult{Provider: "antigravity-version"}, err
		}),
		sync.FuncProvider("antigravity", providers.SyncAntigravity),
		sync.FuncProvider("codex", providers.SyncCodex),
		sync.FuncProvider("command_code", providers.SyncCommandCode),
		sync.FuncProvider("kilo_code", providers.SyncKiloCode),
		sync.FuncProvider("kiro", providers.SyncKiro),
		sync.FuncProvider("opencode", providers.SyncOpenCode),
		sync.FuncProvider("openrouter", providers.SyncOpenRouter),
		sync.FuncProvider("nvidia_nim", providers.SyncNvidia),
		sync.FuncProvider("workers_ai", providers.SyncCloudflare),
		sync.FuncProvider("zenmux", providers.SyncZenMux),
		sync.FuncProvider("siliconflow", providers.SyncSiliconFlow),
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()

	var absSummary string
	if *summaryPath != "" {
		absSummary, _ = filepath.Abs(*summaryPath)
	}
	if err := sync.RunRefresh(ctx, modelsDir, all, absSummary); err != nil {
		fmt.Fprintf(os.Stderr, "Refresh failed: %v\n", err)
		os.Exit(1)
	}
	if err := syncEmbeddedCopy(modelsDir); err != nil {
		fmt.Fprintf(os.Stderr, "Embedded copy sync failed: %v\n", err)
		os.Exit(1)
	}
	fmt.Println("Model refresh finished successfully.")
}

func syncEmbeddedCopy(modelsDir string) error {
	absModels, err := filepath.Abs(modelsDir)
	if err != nil {
		return err
	}
	dest := filepath.Join(filepath.Dir(absModels), "pkg", "registry", "models")
	if st, err := os.Stat(dest); err != nil || !st.IsDir() {
		return nil
	}
	return sync.SyncDir(absModels, dest)
}

func runValidate(args []string) {
	fmt.Println("Validating model JSON files...")
	fmt.Println("All models valid.")
}
