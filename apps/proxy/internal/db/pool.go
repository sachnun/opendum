package db

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

type DB struct {
	Pool *pgxpool.Pool
	*Queries
}

func Open(databaseURL string) (*DB, error) {
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, err
	}
	config.MaxConns = 25
	config.MinConns = 5
	config.MaxConnLifetime = 30 * time.Minute

	pool, err := pgxpool.NewWithConfig(context.Background(), config)
	if err != nil {
		return nil, err
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, err
	}

	database := &DB{Pool: pool, Queries: New(pool)}
	if err := database.ensureSchema(ctx); err != nil {
		pool.Close()
		return nil, err
	}

	return database, nil
}

// ensureSchema adds columns the proxy needs but that the committed drizzle
// migration may not have applied yet. The proxy schema ships on the proxy
// deploy, which is independent of the dashboard, so the proxy cannot assume a
// matching schema exists. Each statement is idempotent and safe on every boot.
func (d *DB) ensureSchema(ctx context.Context) error {
	statements := []string{
		`ALTER TABLE provider_account_model_health ADD COLUMN IF NOT EXISTS "quotaLockedUntil" TIMESTAMP`,
		`ALTER TABLE provider_account_model_health ADD COLUMN IF NOT EXISTS "quotaLockReason" TEXT`,
	}
	for _, statement := range statements {
		if _, err := d.Pool.Exec(ctx, statement); err != nil {
			return fmt.Errorf("ensure schema: %w", err)
		}
	}
	return nil
}

func (d *DB) Close() {
	d.Pool.Close()
}

func NonNilStrings(values []string) []string {
	if values == nil {
		return []string{}
	}
	return values
}
