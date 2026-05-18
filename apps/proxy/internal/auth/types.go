package auth

type RateLimitRule struct {
	Target     string `json:"target"`
	TargetType string `json:"targetType"`
	PerMinute  *int   `json:"perMinute"`
	PerHour    *int   `json:"perHour"`
	PerDay     *int   `json:"perDay"`
}

type Result struct {
	Valid             bool
	UserID            string
	APIKeyID          string
	ModelAccessMode   string
	ModelAccessList   []string
	AccountAccessMode string
	AccountAccessList []string
	RoamingEnabled    bool
	RateLimitRules    []RateLimitRule
	Error             string
}

type ModelAccess struct {
	Mode   string
	Models []string
}

type AccountAccess struct {
	Mode     string
	Accounts []string
}

type ModelValidationResult struct {
	Valid    bool
	Provider *string
	Model    string
	Error    string
	Param    string
	Code     string
}

type AccountModelAvailability struct {
	ActiveProviders              map[string]struct{}
	AccountCountByProvider       map[string]int
	DisabledCountByProviderModel map[string]int
	ActiveAccountIDsByProvider   map[string][]string
	AccountTierByID              map[string]string
	AuthlessProviderModels       map[string]map[string]struct{}
}

type cacheValue struct {
	Valid             bool            `json:"valid"`
	UserID            string          `json:"userId,omitempty"`
	APIKeyID          string          `json:"apiKeyId,omitempty"`
	ModelAccessMode   string          `json:"modelAccessMode,omitempty"`
	ModelAccessList   []string        `json:"modelAccessList,omitempty"`
	AccountAccessMode string          `json:"accountAccessMode,omitempty"`
	AccountAccessList []string        `json:"accountAccessList,omitempty"`
	RoamingEnabled    bool            `json:"roamingEnabled,omitempty"`
	ExpiresAtMs       *int64          `json:"expiresAtMs,omitempty"`
	UpdatedAtMicros   *int64          `json:"updatedAtMicros,omitempty"`
	RateLimitRules    []RateLimitRule `json:"rateLimitRules,omitempty"`
	Error             string          `json:"error,omitempty"`
}

type disabledModelsCacheValue struct {
	Models []string `json:"models"`
}
