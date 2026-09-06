package providers

import (
	"context"

	"github.com/opendum/opendum/packages/ai/pkg/sync"
)

type providerEntry struct {
	name string
	fn   func(ctx context.Context, modelsDir string) (sync.ProviderResult, error)
}

var entries = []providerEntry{
	{name: "antigravity-version", fn: syncAntigravityVersion},
	{name: "antigravity", fn: SyncAntigravity},
	{name: "codex", fn: SyncCodex},
	{name: "command_code", fn: SyncCommandCode},
	{name: "kilo_code", fn: SyncKiloCode},
	{name: "kiro", fn: SyncKiro},
	{name: "opencode", fn: SyncOpenCode},
	{name: "openrouter", fn: SyncOpenRouter},
	{name: "nvidia_nim", fn: SyncNvidia},
	{name: "workers_ai", fn: SyncCloudflare},
	{name: "zenmux", fn: SyncZenMux},
	{name: "siliconflow", fn: SyncSiliconFlow},
}

func syncAntigravityVersion(ctx context.Context, modelsDir string) (sync.ProviderResult, error) {
	err := SyncAntigravityVersion(ctx, modelsDir)
	return sync.ProviderResult{Provider: "antigravity-version"}, err
}

// All returns every registered model-sync provider in registration order.
func All() []sync.Provider {
	out := make([]sync.Provider, 0, len(entries))
	for _, e := range entries {
		out = append(out, sync.FuncProvider(e.name, e.fn))
	}
	return out
}

// Names lists the registered provider names in registration order.
func Names() []string {
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		names = append(names, e.name)
	}
	return names
}
