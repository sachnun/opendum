package freebuff

import (
	"context"
	"encoding/json"
	"time"
)

const (
	snapshotKeyPrefix = "opendum:freebuff:session:"
	snapshotTTL       = 2 * time.Hour
)

type Snapshot struct {
	AccountID     string `json:"accountId"`
	Status        string `json:"status"`
	Model         string `json:"model,omitempty"`
	InstanceID    string `json:"instanceId,omitempty"`
	ExpiresAt     string `json:"expiresAt,omitempty"`
	CooldownUntil string `json:"cooldownUntil,omitempty"`
	LastError     string `json:"lastError,omitempty"`
	UpdatedAt     string `json:"updatedAt"`
}

func (s *accountState) snapshot(accountID string) Snapshot {
	snap := Snapshot{AccountID: accountID, UpdatedAt: time.Now().UTC().Format(time.RFC3339)}
	now := time.Now()
	switch {
	case s.disabled:
		snap.Status = "disabled"
	case now.Before(s.cooldownUntil):
		snap.Status = "cooling"
		snap.CooldownUntil = s.cooldownUntil.UTC().Format(time.RFC3339)
	case s.session != nil && s.session.status == statusActive:
		snap.Status = "active"
	case s.session != nil && s.session.status == statusQueued:
		snap.Status = "queued"
	default:
		snap.Status = "idle"
	}
	if s.session != nil {
		snap.Model = s.session.model
		snap.InstanceID = s.session.instanceID
		if !s.session.expiresAt.IsZero() {
			snap.ExpiresAt = s.session.expiresAt.UTC().Format(time.RFC3339)
		}
	}
	snap.LastError = s.lastError
	return snap
}

func (m *Manager) store(snap Snapshot) {
	if m == nil || m.redis == nil || snap.AccountID == "" {
		return
	}
	data, err := json.Marshal(snap)
	if err != nil {
		return
	}
	_ = m.redis.Set(context.Background(), snapshotKeyPrefix+snap.AccountID, data, snapshotTTL).Err()
}
