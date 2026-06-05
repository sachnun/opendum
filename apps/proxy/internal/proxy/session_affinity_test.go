package proxy

import (
	"testing"

	appdb "github.com/opendum/opendum/apps/proxy/internal/db"
)

func TestBoostAffinityAccountMovesTarget(t *testing.T) {
	accounts := []appdb.ProviderAccount{
		{ID: "a1"}, {ID: "a2"}, {ID: "a3"}, {ID: "a4"},
	}
	result := boostAffinityAccount(accounts, "a3")
	if result[0].ID != "a3" {
		t.Fatalf("first account = %q, want a3", result[0].ID)
	}
	// Original order of remaining accounts should be preserved.
	if result[1].ID != "a1" || result[2].ID != "a2" || result[3].ID != "a4" {
		t.Fatalf("remaining order = [%s, %s, %s], want [a1, a2, a4]", result[1].ID, result[2].ID, result[3].ID)
	}
}

func TestBoostAffinityAccountAlreadyFirst(t *testing.T) {
	accounts := []appdb.ProviderAccount{
		{ID: "a1"}, {ID: "a2"},
	}
	result := boostAffinityAccount(accounts, "a1")
	if result[0].ID != "a1" || result[1].ID != "a2" {
		t.Fatalf("order changed unexpectedly: [%s, %s]", result[0].ID, result[1].ID)
	}
}

func TestBoostAffinityAccountNotFound(t *testing.T) {
	accounts := []appdb.ProviderAccount{
		{ID: "a1"}, {ID: "a2"},
	}
	result := boostAffinityAccount(accounts, "missing")
	if result[0].ID != "a1" || result[1].ID != "a2" {
		t.Fatalf("order changed for missing target: [%s, %s]", result[0].ID, result[1].ID)
	}
}

func TestBoostAffinityAccountEmpty(t *testing.T) {
	result := boostAffinityAccount(nil, "a1")
	if len(result) != 0 {
		t.Fatalf("expected nil/empty, got %d accounts", len(result))
	}
}

func TestBoostAffinityAccountEmptySessionID(t *testing.T) {
	accounts := []appdb.ProviderAccount{{ID: "a1"}, {ID: "a2"}}
	result := boostAffinityAccount(accounts, "")
	if result[0].ID != "a1" {
		t.Fatalf("order changed for empty session: first = %s", result[0].ID)
	}
}

func TestSessionAffinityKeyDeterministic(t *testing.T) {
	k1 := sessionAffinityKey("user1", "session-abc")
	k2 := sessionAffinityKey("user1", "session-abc")
	if k1 != k2 {
		t.Fatalf("keys differ for same input: %q vs %q", k1, k2)
	}
}

func TestSessionAffinityKeyDiffersByUser(t *testing.T) {
	k1 := sessionAffinityKey("user1", "session-abc")
	k2 := sessionAffinityKey("user2", "session-abc")
	if k1 == k2 {
		t.Fatal("keys should differ for different users")
	}
}

func TestSessionAffinityKeyDiffersBySession(t *testing.T) {
	k1 := sessionAffinityKey("user1", "session-abc")
	k2 := sessionAffinityKey("user1", "session-xyz")
	if k1 == k2 {
		t.Fatal("keys should differ for different sessions")
	}
}

func TestGetAffinityAccountIDNilRedis(t *testing.T) {
	// Should return "" gracefully when Redis is nil.
	got := getAffinityAccountID(nil, nil, "user1", "session-abc")
	if got != "" {
		t.Fatalf("expected empty, got %q", got)
	}
}

func TestSetAffinityAccountIDNilRedis(t *testing.T) {
	// Should not panic when Redis is nil.
	setAffinityAccountID(nil, nil, "user1", "session-abc", "account-1")
}

func TestDeleteAffinityAccountIDNilRedis(t *testing.T) {
	// Should not panic when Redis is nil.
	deleteAffinityAccountID(nil, nil, "user1", "session-abc")
}
