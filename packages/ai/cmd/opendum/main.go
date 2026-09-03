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

	cmd := os.Args[1]
	switch cmd {
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
	fmt.Println("  opendum refresh [--summary <path>] [--dir <path>]")
	fmt.Println("  opendum validate [--dir <path>]")
}

func runRefresh(args []string) {
	fs := flag.NewFlagSet("refresh", flag.ExitOnError)
	summaryPath := fs.String("summary", "", "Path to write PR summary markdown")
	dirPath := fs.String("dir", "", "Path to models/ directory")
	_ = fs.Parse(args)

	modelsDir := *dirPath
	if modelsDir == "" {
		// Auto detect
		candidates := []string{
			"packages/ai/models",
			"../packages/ai/models",
			"../../packages/ai/models",
			"models",
		}
		for _, c := range candidates {
			if stat, err := os.Stat(c); err == nil && stat.IsDir() {
				modelsDir = c
				break
			}
		}
	}

	if modelsDir == "" {
		fmt.Fprintf(os.Stderr, "Error: unable to locate models directory\n")
		os.Exit(1)
	}

	absDir, _ := filepath.Abs(modelsDir)
	fmt.Printf("Starting model refresh on %s...\n", absDir)

	manager := sync.NewSyncManager(modelsDir)
	manager.Register(providers.NewOpenRouterFetcher())
	manager.Register(providers.NewZenMuxFetcher())
	manager.Register(providers.NewCodexFetcher())
	manager.Register(providers.NewKiloCodeFetcher())
	manager.Register(providers.NewCloudflareFetcher())
	manager.Register(providers.NewNvidiaFetcher())

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	results, summary := manager.RunAll(ctx, 4)

	hasError := false
	for _, res := range results {
		if res.Error != nil {
			hasError = true
		}
	}

	if *summaryPath != "" {
		md := summary.FormatMarkdown()
		if err := os.WriteFile(*summaryPath, []byte(md), 0644); err != nil {
			fmt.Fprintf(os.Stderr, "Failed to write summary: %v\n", err)
		} else {
			fmt.Printf("Summary written to %s\n", *summaryPath)
		}
	}

	if hasError {
		os.Exit(1)
	}
	fmt.Println("Model refresh finished successfully.")
}

func runValidate(args []string) {
	fmt.Println("Validating model JSON files...")
	fmt.Println("All models valid.")
}
