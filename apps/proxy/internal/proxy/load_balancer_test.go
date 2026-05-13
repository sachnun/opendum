package proxy

import (
	"testing"
	"time"

	appdb "github.com/opendum/opendum/apps/proxy/internal/db"
)

func TestEffectiveHealthStatusDowngradesExpiredFailed(t *testing.T) {
	now := time.Date(2026, 5, 13, 12, 0, 0, 0, time.UTC)
	changedAt := now.Add(-failedCooldown)
	health := effectiveHealthStatus(appdb.ProviderAccountModelHealth{Status: "failed", StatusChangedAt: &changedAt}, now)

	if health.Status != "degraded" {
		t.Fatalf("expired failed health status = %q, want degraded", health.Status)
	}
}
