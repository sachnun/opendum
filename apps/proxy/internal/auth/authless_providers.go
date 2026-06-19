package auth

var authlessProviderNames = []string{"opencode", "mimo_code"}

func IsAuthlessProvider(provider string) bool {
	for _, name := range authlessProviderNames {
		if provider == name {
			return true
		}
	}
	return false
}
