package db

import (
	"context"
	"database/sql"
	"time"

	"github.com/uptrace/bun"
	"github.com/uptrace/bun/dialect/pgdialect"
	"github.com/uptrace/bun/driver/pgdriver"
)

type DB struct {
	*bun.DB
}

func Open(databaseURL string) (*DB, error) {
	sqldb := sql.OpenDB(pgdriver.NewConnector(pgdriver.WithDSN(databaseURL)))
	sqldb.SetMaxOpenConns(25)
	sqldb.SetMaxIdleConns(5)
	sqldb.SetConnMaxLifetime(30 * time.Minute)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := sqldb.PingContext(ctx); err != nil {
		_ = sqldb.Close()
		return nil, err
	}

	return &DB{DB: bun.NewDB(sqldb, pgdialect.New())}, nil
}

type ProviderAccount struct {
	bun.BaseModel `bun:"table:provider_account"`

	ID                        string     `bun:"id,pk"`
	UserID                    string     `bun:"userId"`
	Provider                  string     `bun:"provider"`
	Name                      string     `bun:"name"`
	AccessToken               string     `bun:"accessToken"`
	RefreshToken              string     `bun:"refreshToken"`
	ExpiresAt                 time.Time  `bun:"expiresAt"`
	APIKey                    *string    `bun:"apiKey"`
	ProjectID                 *string    `bun:"projectId"`
	Tier                      *string    `bun:"tier"`
	AccountID                 *string    `bun:"accountId"`
	Email                     *string    `bun:"email"`
	IsActive                  bool       `bun:"isActive"`
	DisabledUntil             *time.Time `bun:"disabledUntil"`
	LastUsedAt                *time.Time `bun:"lastUsedAt"`
	RequestCount              int        `bun:"requestCount"`
	ErrorCount                int        `bun:"errorCount"`
	ConsecutiveErrors         int        `bun:"consecutiveErrors"`
	LastErrorAt               *time.Time `bun:"lastErrorAt"`
	LastErrorMessage          *string    `bun:"lastErrorMessage"`
	LastErrorCode             *int       `bun:"lastErrorCode"`
	LastRecoveredByRotationAt *time.Time `bun:"lastRecoveredByRotationAt"`
	Status                    string     `bun:"status"`
	StatusReason              *string    `bun:"statusReason"`
	StatusChangedAt           *time.Time `bun:"statusChangedAt"`
	SuccessCount              int        `bun:"successCount"`
	LastSuccessAt             *time.Time `bun:"lastSuccessAt"`
	CreatedAt                 time.Time  `bun:"createdAt"`
	UpdatedAt                 time.Time  `bun:"updatedAt"`
}

type ProviderAccountErrorHistory struct {
	bun.BaseModel `bun:"table:provider_account_error_history"`

	ID                string    `bun:"id,pk"`
	ProviderAccountID string    `bun:"providerAccountId"`
	UserID            string    `bun:"userId"`
	Model             *string   `bun:"model"`
	ErrorCode         int       `bun:"errorCode"`
	ErrorMessage      string    `bun:"errorMessage"`
	CreatedAt         time.Time `bun:"createdAt"`
}

type DisabledModel struct {
	bun.BaseModel `bun:"table:disabled_model"`

	ID        string    `bun:"id,pk"`
	UserID    string    `bun:"userId"`
	Model     string    `bun:"model"`
	CreatedAt time.Time `bun:"createdAt"`
}

type ProxyAPIKey struct {
	bun.BaseModel `bun:"table:proxy_api_key"`

	ID                string     `bun:"id,pk"`
	UserID            string     `bun:"userId"`
	KeyHash           string     `bun:"keyHash"`
	KeyPreview        string     `bun:"keyPreview"`
	EncryptedKey      *string    `bun:"encryptedKey"`
	Name              *string    `bun:"name"`
	ModelAccessMode   string     `bun:"modelAccessMode"`
	ModelAccessList   []string   `bun:"modelAccessList,array"`
	AccountAccessMode string     `bun:"accountAccessMode"`
	AccountAccessList []string   `bun:"accountAccessList,array"`
	IsActive          bool       `bun:"isActive"`
	ExpiresAt         *time.Time `bun:"expiresAt"`
	LastUsedAt        *time.Time `bun:"lastUsedAt"`
	CreatedAt         time.Time  `bun:"createdAt"`
	UpdatedAt         time.Time  `bun:"updatedAt"`
}

type ProxyAPIKeyRateLimit struct {
	bun.BaseModel `bun:"table:proxy_api_key_rate_limit"`

	ID         string    `bun:"id,pk"`
	APIKeyID   string    `bun:"apiKeyId"`
	Target     string    `bun:"target"`
	TargetType string    `bun:"targetType"`
	PerMinute  *int      `bun:"perMinute"`
	PerHour    *int      `bun:"perHour"`
	PerDay     *int      `bun:"perDay"`
	CreatedAt  time.Time `bun:"createdAt"`
	UpdatedAt  time.Time `bun:"updatedAt"`
}

type UsageLog struct {
	bun.BaseModel `bun:"table:usage_log"`

	ID                string    `bun:"id,pk"`
	UserID            string    `bun:"userId"`
	ProviderAccountID *string   `bun:"providerAccountId"`
	ProxyAPIKeyID     *string   `bun:"proxyApiKeyId"`
	Model             string    `bun:"model"`
	InputTokens       int       `bun:"inputTokens"`
	OutputTokens      int       `bun:"outputTokens"`
	StatusCode        *int      `bun:"statusCode"`
	Duration          *int      `bun:"duration"`
	CreatedAt         time.Time `bun:"createdAt"`
}

type ProviderAccountModelHealth struct {
	bun.BaseModel `bun:"table:provider_account_model_health"`

	ID                string     `bun:"id,pk"`
	ProviderAccountID string     `bun:"providerAccountId"`
	Model             string     `bun:"model"`
	ConsecutiveErrors int        `bun:"consecutiveErrors"`
	Status            string     `bun:"status"`
	StatusReason      *string    `bun:"statusReason"`
	StatusChangedAt   *time.Time `bun:"statusChangedAt"`
	LastErrorAt       *time.Time `bun:"lastErrorAt"`
	LastErrorCode     *int       `bun:"lastErrorCode"`
	LastErrorMessage  *string    `bun:"lastErrorMessage"`
	LastSuccessAt     *time.Time `bun:"lastSuccessAt"`
	CreatedAt         time.Time  `bun:"createdAt"`
	UpdatedAt         time.Time  `bun:"updatedAt"`
}

type ProviderAccountDisabledModel struct {
	bun.BaseModel `bun:"table:provider_account_disabled_model"`

	ID                string    `bun:"id,pk"`
	ProviderAccountID string    `bun:"providerAccountId"`
	Model             string    `bun:"model"`
	CreatedAt         time.Time `bun:"createdAt"`
}
