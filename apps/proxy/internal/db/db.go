package db

import (
	"context"
	"database/sql"
	"fmt"
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

	db := &DB{DB: bun.NewDB(sqldb, pgdialect.New())}
	if err := db.ensureSchema(ctx); err != nil {
		_ = sqldb.Close()
		return nil, err
	}
	return db, nil
}

// ensureSchema adds columns the proxy needs but that the dashboard's schema push
// may not have applied yet. Schema changes here ship with the proxy deploy, which
// is independent of the dashboard, so the proxy cannot assume a matching schema.
// Each statement is idempotent and safe to run on every boot.
func (db *DB) ensureSchema(ctx context.Context) error {
	statements := []string{
		`ALTER TABLE provider_account_model_health ADD COLUMN IF NOT EXISTS "quotaLockedUntil" TIMESTAMP`,
		`ALTER TABLE provider_account_model_health ADD COLUMN IF NOT EXISTS "quotaLockReason" TEXT`,
	}
	for _, statement := range statements {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("ensure schema: %w", err)
		}
	}
	return nil
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
	LastErrorCode             *int       `bun:"lastErrorCode"`
	LastRecoveredByRotationAt *time.Time `bun:"lastRecoveredByRotationAt"`
	Status                    string     `bun:"status"`
	StatusChangedAt           *time.Time `bun:"statusChangedAt"`
	SuccessCount              int        `bun:"successCount"`
	LastSuccessAt             *time.Time `bun:"lastSuccessAt"`
	CreatedAt                 time.Time  `bun:"createdAt"`
	UpdatedAt                 time.Time  `bun:"updatedAt"`
}

type UserPointBalance struct {
	bun.BaseModel `bun:"table:user_point_balance"`

	UserID    string    `bun:"userId,pk"`
	Balance   int       `bun:"balance"`
	CreatedAt time.Time `bun:"createdAt"`
	UpdatedAt time.Time `bun:"updatedAt"`
}

type UserSharingSetting struct {
	bun.BaseModel `bun:"table:user_sharing_setting"`

	UserID    string    `bun:"userId,pk"`
	Enabled   bool      `bun:"enabled"`
	CreatedAt time.Time `bun:"createdAt"`
	UpdatedAt time.Time `bun:"updatedAt"`
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
	Name              *string    `bun:"name"`
	ModelAccessMode   string     `bun:"modelAccessMode"`
	ModelAccessList   []string   `bun:"modelAccessList,array"`
	AccountAccessMode string     `bun:"accountAccessMode"`
	AccountAccessList []string   `bun:"accountAccessList,array"`
	RoamingEnabled    bool       `bun:"roamingEnabled"`
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

type PointTransaction struct {
	bun.BaseModel `bun:"table:point_transaction"`

	ID             string    `bun:"id,pk"`
	UserID         string    `bun:"userId"`
	Amount         int       `bun:"amount"`
	Type           string    `bun:"type"`
	BalanceAfter   int       `bun:"balanceAfter"`
	IdempotencyKey *string   `bun:"idempotencyKey"`
	UsageLogID     *string   `bun:"usageLogId"`
	CreatedAt      time.Time `bun:"createdAt"`
}

type ProviderAccountModelHealth struct {
	bun.BaseModel `bun:"table:provider_account_model_health"`

	ID                      string     `bun:"id,pk"`
	ProviderAccountID       string     `bun:"providerAccountId"`
	Model                   string     `bun:"model"`
	ConsecutiveErrors       int        `bun:"consecutiveErrors"`
	Status                  string     `bun:"status"`
	StatusChangedAt         *time.Time `bun:"statusChangedAt"`
	LastErrorAt             *time.Time `bun:"lastErrorAt"`
	LastErrorCode           *int       `bun:"lastErrorCode"`
	LastSuccessAt           *time.Time `bun:"lastSuccessAt"`
	UnhealthyCountUpdatedAt *time.Time `bun:"unhealthyCountUpdatedAt"`
	QuotaLockedUntil        *time.Time `bun:"quotaLockedUntil"`
	QuotaLockReason         *string    `bun:"quotaLockReason"`
	CreatedAt               time.Time  `bun:"createdAt"`
	UpdatedAt               time.Time  `bun:"updatedAt"`
}

type ProviderAccountDisabledModel struct {
	bun.BaseModel `bun:"table:provider_account_disabled_model"`

	ID                string    `bun:"id,pk"`
	ProviderAccountID string    `bun:"providerAccountId"`
	Model             string    `bun:"model"`
	CreatedAt         time.Time `bun:"createdAt"`
}
