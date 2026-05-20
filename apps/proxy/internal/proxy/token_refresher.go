package proxy

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/uptrace/bun"

	"github.com/opendum/opendum/apps/proxy/internal/cryptojs"
	appdb "github.com/opendum/opendum/apps/proxy/internal/db"
	"github.com/opendum/opendum/apps/proxy/internal/providers"
)

const (
	tokenRefreshLockPrefix     = "opendum:provider-account:refresh-lock:"
	tokenRefreshLockTTL        = 2 * time.Minute
	tokenRefreshWaitTimeout    = 3 * time.Second
	tokenRefreshWaitInterval   = 250 * time.Millisecond
	tokenRefreshAccountTimeout = 90 * time.Second
	tokenRefreshBatchLimit     = 500
)

func (s *Service) StartTokenRefresher(ctx context.Context, interval time.Duration) {
	if interval <= 0 {
		return
	}
	slog.Info("token refresher started", "interval", interval.String())
	s.refreshExpiringTokens(ctx)

	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			slog.Info("token refresher stopped")
			return
		case <-ticker.C:
			s.refreshExpiringTokens(ctx)
		}
	}
}

func (s *Service) refreshExpiringTokens(ctx context.Context) {
	accounts, err := s.expiringRefreshableAccounts(ctx)
	if err != nil {
		if ctx.Err() == nil {
			slog.Error("failed to scan expiring provider tokens", "error", err)
		}
		return
	}

	refreshed := 0
	skipped := 0
	failed := 0
	for _, account := range accounts {
		if ctx.Err() != nil {
			return
		}
		providerImpl, ok := s.providerRegistry.Get(account.Provider)
		if !ok {
			skipped++
			continue
		}

		accountCtx, cancel := context.WithTimeout(ctx, tokenRefreshAccountTimeout)
		_, _, didRefresh, err := s.refreshAccountCredentialsIfDue(accountCtx, account, providerImpl, false)
		cancel()

		if err != nil {
			failed++
			slog.Warn("failed to refresh provider token", "account", account.ID, "provider", account.Provider, "error", err)
			continue
		}
		if didRefresh {
			refreshed++
			continue
		}
		skipped++
	}

	if len(accounts) > 0 || failed > 0 {
		slog.Info("token refresh scan complete", "scanned", len(accounts), "refreshed", refreshed, "skipped", skipped, "failed", failed)
	}
}

func (s *Service) expiringRefreshableAccounts(ctx context.Context) ([]appdb.ProviderAccount, error) {
	names := s.providerRegistry.RefreshableProviderNames()
	if len(names) == 0 {
		return nil, nil
	}

	accounts := []appdb.ProviderAccount{}
	now := time.Now()
	for _, name := range names {
		providerImpl, ok := s.providerRegistry.Get(name)
		if !ok {
			continue
		}
		buffer := providers.RefreshBufferFor(providerImpl)
		if buffer <= 0 {
			continue
		}

		var rows []appdb.ProviderAccount
		err := s.db.NewSelect().Model(&rows).
			Column("id", "provider", "accessToken", "refreshToken", "expiresAt", "accountId", "projectId", "tier", "email").
			Where("\"isActive\" = TRUE").
			Where("(\"disabledUntil\" IS NULL OR \"disabledUntil\" <= ?)", now).
			Where("provider = ?", name).
			Where("\"refreshToken\" <> ''").
			Where("(\"expiresAt\" <= ? OR (provider = 'copilot' AND (tier IS NULL OR tier NOT IN (?))))", now.Add(buffer), bun.In(copilotCanonicalTiers)).
			OrderExpr("\"expiresAt\" ASC").
			Limit(tokenRefreshBatchLimit).
			Scan(ctx)
		if err != nil {
			return nil, err
		}
		accounts = append(accounts, rows...)
	}
	return accounts, nil
}

func (s *Service) credentialsForAccount(ctx context.Context, account appdb.ProviderAccount, providerImpl providers.Provider) (string, appdb.ProviderAccount, error) {
	requestAccount, err := s.loadProviderAccountCredentials(ctx, account)
	if err != nil {
		return "", requestAccount, err
	}
	credentials, err := cryptojs.Decrypt(s.secret, requestAccount.AccessToken)
	if err != nil {
		return "", requestAccount, err
	}

	refreshedCredentials, refreshedAccount, _, err := s.refreshAccountCredentialsIfDue(ctx, requestAccount, providerImpl, true)
	if err != nil {
		if time.Now().After(requestAccount.ExpiresAt) {
			return "", requestAccount, err
		}
		return credentials, requestAccount, nil
	}
	if refreshedCredentials != "" {
		return refreshedCredentials, refreshedAccount, nil
	}
	return credentials, requestAccount, nil
}

func (s *Service) refreshAccountCredentialsIfDue(ctx context.Context, account appdb.ProviderAccount, providerImpl providers.Provider, waitForLock bool) (string, appdb.ProviderAccount, bool, error) {
	refresher, ok := providerImpl.(providers.CredentialRefresher)
	if !ok || !accountNeedsCredentialRefresh(account, providerImpl, time.Now()) {
		return "", account, false, nil
	}
	if account.RefreshToken == "" {
		if waitForLock && time.Now().After(account.ExpiresAt) {
			return "", account, false, fmt.Errorf("provider account token has expired and cannot be refreshed")
		}
		return "", account, false, nil
	}
	refreshToken, err := cryptojs.Decrypt(s.secret, account.RefreshToken)
	if err != nil {
		return "", account, false, err
	}
	if strings.TrimSpace(refreshToken) == "" {
		if waitForLock && time.Now().After(account.ExpiresAt) {
			return "", account, false, fmt.Errorf("provider account token has expired and cannot be refreshed")
		}
		return "", account, false, nil
	}

	lockValue, acquired, err := s.acquireRefreshLock(ctx, account.ID)
	if err != nil {
		return "", account, false, err
	}
	if !acquired {
		if waitForLock && time.Now().After(account.ExpiresAt) {
			credentials, updatedAccount, err := s.waitForRefreshedAccount(ctx, account)
			return credentials, updatedAccount, false, err
		}
		return "", account, false, nil
	}
	defer s.releaseRefreshLock(account.ID, lockValue)

	current, err := s.loadProviderAccountCredentialsByID(ctx, account.ID)
	if err != nil {
		return "", account, false, err
	}
	if !accountNeedsCredentialRefresh(current, providerImpl, time.Now()) {
		credentials, err := cryptojs.Decrypt(s.secret, current.AccessToken)
		return credentials, current, false, err
	}

	if current.RefreshToken == "" {
		if waitForLock && time.Now().After(current.ExpiresAt) {
			return "", current, false, fmt.Errorf("provider account token has expired and cannot be refreshed")
		}
		return "", current, false, nil
	}
	refreshToken, err = cryptojs.Decrypt(s.secret, current.RefreshToken)
	if err != nil {
		return "", current, false, err
	}
	if strings.TrimSpace(refreshToken) == "" {
		if waitForLock && time.Now().After(current.ExpiresAt) {
			return "", current, false, fmt.Errorf("provider account token has expired and cannot be refreshed")
		}
		return "", current, false, nil
	}
	refreshed, err := refresher.RefreshCredentials(ctx, s.client, refreshToken, current)
	if err != nil {
		return "", current, false, err
	}
	updatedAccount, err := s.persistRefreshedCredentials(ctx, current, refreshed)
	if err != nil {
		return "", current, false, err
	}
	return refreshed.AccessToken, updatedAccount, true, nil
}

func (s *Service) loadProviderAccountCredentials(ctx context.Context, account appdb.ProviderAccount) (appdb.ProviderAccount, error) {
	if account.AccessToken != "" && account.RefreshToken != "" {
		return account, nil
	}
	return s.loadProviderAccountCredentialsByID(ctx, account.ID)
}

func (s *Service) loadProviderAccountCredentialsByID(ctx context.Context, accountID string) (appdb.ProviderAccount, error) {
	var account appdb.ProviderAccount
	err := s.db.NewSelect().Model(&account).
		Column("id", "provider", "accessToken", "refreshToken", "expiresAt", "accountId", "projectId", "tier", "email").
		Where("id = ?", accountID).
		Limit(1).
		Scan(ctx)
	return account, err
}

func (s *Service) persistRefreshedCredentials(ctx context.Context, account appdb.ProviderAccount, refreshed providers.RefreshedCredentials) (appdb.ProviderAccount, error) {
	if refreshed.AccessToken == "" || refreshed.RefreshToken == "" || refreshed.ExpiresAt.IsZero() {
		return account, fmt.Errorf("provider token refresh returned incomplete credentials")
	}
	storeAccessToken := refreshed.AccessToken
	if strings.TrimSpace(refreshed.StoreAccessToken) != "" {
		storeAccessToken = refreshed.StoreAccessToken
	}
	encryptedAccess, err := cryptojs.Encrypt(s.secret, storeAccessToken)
	if err != nil {
		return account, err
	}
	encryptedRefresh, err := cryptojs.Encrypt(s.secret, refreshed.RefreshToken)
	if err != nil {
		return account, err
	}

	now := time.Now()
	query := s.db.NewUpdate().Model((*appdb.ProviderAccount)(nil)).
		Set("\"accessToken\" = ?", encryptedAccess).
		Set("\"refreshToken\" = ?", encryptedRefresh).
		Set("\"expiresAt\" = ?", refreshed.ExpiresAt).
		Set("\"updatedAt\" = ?", now).
		Where("id = ?", account.ID)

	account.AccessToken = encryptedAccess
	account.RefreshToken = encryptedRefresh
	account.ExpiresAt = refreshed.ExpiresAt
	account.UpdatedAt = now
	if refreshed.ProjectID != "" {
		query.Set("\"projectId\" = ?", refreshed.ProjectID)
		account.ProjectID = strPtr(refreshed.ProjectID)
	}
	if refreshed.Tier != "" {
		query.Set("tier = ?", refreshed.Tier)
		account.Tier = strPtr(refreshed.Tier)
	}
	if refreshed.Email != "" {
		query.Set("email = ?", refreshed.Email)
		account.Email = strPtr(refreshed.Email)
	}
	if refreshed.AccountID != "" {
		query.Set("\"accountId\" = ?", refreshed.AccountID)
		account.AccountID = strPtr(refreshed.AccountID)
	}
	if _, err := query.Exec(ctx); err != nil {
		return account, err
	}
	return account, nil
}

func (s *Service) acquireRefreshLock(ctx context.Context, accountID string) (string, bool, error) {
	if s.redis == nil {
		return "", true, nil
	}
	value := appdb.NewID()
	acquired, err := s.redis.SetNX(ctx, tokenRefreshLockKey(accountID), value, tokenRefreshLockTTL).Result()
	return value, acquired, err
}

func (s *Service) releaseRefreshLock(accountID, value string) {
	if s.redis == nil || value == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_ = s.redis.Eval(ctx, `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`, []string{tokenRefreshLockKey(accountID)}, value).Err()
}

func (s *Service) waitForRefreshedAccount(ctx context.Context, previous appdb.ProviderAccount) (string, appdb.ProviderAccount, error) {
	timer := time.NewTimer(tokenRefreshWaitTimeout)
	defer timer.Stop()
	ticker := time.NewTicker(tokenRefreshWaitInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return "", previous, ctx.Err()
		case <-timer.C:
			return "", previous, fmt.Errorf("provider account token refresh is already in progress")
		case <-ticker.C:
			current, err := s.loadProviderAccountCredentialsByID(ctx, previous.ID)
			if err != nil {
				return "", previous, err
			}
			if time.Now().Before(current.ExpiresAt) && current.ExpiresAt.After(previous.ExpiresAt) {
				credentials, err := cryptojs.Decrypt(s.secret, current.AccessToken)
				return credentials, current, err
			}
		}
	}
}

func accountNeedsCredentialRefresh(account appdb.ProviderAccount, providerImpl providers.Provider, now time.Time) bool {
	if account.Provider == "copilot" && !isCanonicalCopilotTier(account.Tier) {
		return true
	}
	return now.After(account.ExpiresAt.Add(-providers.RefreshBufferFor(providerImpl)))
}

var copilotCanonicalTiers = []string{"free", "student", "pro", "pro+", "business", "enterprise"}

func isCanonicalCopilotTier(tier *string) bool {
	if tier == nil {
		return false
	}
	value := strings.ToLower(strings.TrimSpace(*tier))
	for _, canonical := range copilotCanonicalTiers {
		if value == canonical {
			return true
		}
	}
	return false
}

func tokenRefreshLockKey(accountID string) string {
	return tokenRefreshLockPrefix + accountID
}
