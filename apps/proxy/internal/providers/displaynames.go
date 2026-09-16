package providers

var providerDisplayNames = map[string]string{
	"antigravity": "Antigravity",
	"perch":       "Perch",
	"cline":       "Cline",
	"codex":       "Codex",
	"freebuff":    "Freebuff",
	"harbor":      "Harbor",
	"hyper":       "Charm",
	"kiro":        "Kiro",
	"nvidia_nim":  "Nvidia",
	"openrouter":  "OpenRouter",
	"workers_ai":  "Cloudflare",
	"workbuddy":   "WorkBuddy",
	"zenmux":      "ZenMux",
	"opencode":    "Opencode",
	"kilo_code":   "Kilo Code",
}

func DisplayName(provider string) string {
	if name, ok := providerDisplayNames[provider]; ok {
		return name
	}
	if provider == "" {
		return ""
	}
	return provider
}
