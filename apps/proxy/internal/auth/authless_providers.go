package auth

var authlessProviderNames = []string{"opencode"}

func IsAuthlessProvider(provider string) bool {
	for _, name := range authlessProviderNames {
		if provider == name {
			return true
		}
	}
	return false
}
