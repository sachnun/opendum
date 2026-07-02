package sessionaffinity

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
)

func TestPreferMovesStickyToFront(t *testing.T) {
	items := []string{"a", "b", "c", "d"}
	got := Prefer(items, func(s string) bool { return s == "c" })
	want := []string{"c", "a", "b", "d"}
	if len(got) != len(want) {
		t.Fatalf("len = %d, want %d (%v)", len(got), len(want), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got = %v, want %v", got, want)
		}
	}
}

func TestPreferKeepsOrderWhenStickyFirst(t *testing.T) {
	items := []string{"a", "b", "c"}
	got := Prefer(items, func(s string) bool { return s == "a" })
	if len(got) != 3 || got[0] != "a" || got[1] != "b" || got[2] != "c" {
		t.Fatalf("got = %v, want [a b c]", got)
	}
}

func TestPreferReturnsUnchangedWhenNoMatch(t *testing.T) {
	items := []string{"a", "b"}
	got := Prefer(items, func(s string) bool { return s == "z" })
	if len(got) != 2 || got[0] != "a" || got[1] != "b" {
		t.Fatalf("got = %v, want unchanged [a b]", got)
	}
}

func TestPreferHandlesEmptyAndNilPredicate(t *testing.T) {
	if got := Prefer([]string{}, func(s string) bool { return true }); len(got) != 0 {
		t.Fatalf("empty got = %v", got)
	}
	items := []string{"a", "b"}
	if got := Prefer(items, nil); len(got) != 2 || got[0] != "a" || got[1] != "b" {
		t.Fatalf("nil predicate got = %v, want unchanged", got)
	}
}

func TestPreferPreservesStructSlice(t *testing.T) {
	type acct struct {
		ID string
	}
	items := []acct{{ID: "x"}, {ID: "y"}, {ID: "z"}}
	got := Prefer(items, func(a acct) bool { return a.ID == "z" })
	if len(got) != 3 || got[0].ID != "z" || got[1].ID != "x" || got[2].ID != "y" {
		t.Fatalf("got = %+v, want z,x,y", got)
	}
}

func TestEnabledRespectsOptInProviders(t *testing.T) {
	a := New(nil, []string{"zenmux", " openrouter "})
	if !a.Enabled("zenmux") {
		t.Fatal("zenmux should be enabled")
	}
	if !a.Enabled("openrouter") {
		t.Fatal("openrouter should be enabled (trim)")
	}
	if a.Enabled("siliconflow") {
		t.Fatal("siliconflow should not be enabled")
	}
	if a.Enabled("") {
		t.Fatal("empty provider should not be enabled")
	}
}

func TestEnabledNilSafe(t *testing.T) {
	var a *Affinity
	if a.Enabled("zenmux") {
		t.Fatal("nil Affinity should not enable anything")
	}
}

func TestLookupStoreNilSafe(t *testing.T) {
	var a *Affinity
	ctx := context.Background()
	if id := a.Lookup(ctx, "u", "s"); id != "" {
		t.Fatalf("nil Lookup = %q, want empty", id)
	}
	a.Store(ctx, "u", "s", "acct_1")
}

func TestLookupStoreNoOpWithoutRedis(t *testing.T) {
	a := New(nil, []string{"zenmux"})
	ctx := context.Background()
	if id := a.Lookup(ctx, "u", "s"); id != "" {
		t.Fatalf("Lookup without redis = %q, want empty", id)
	}
	a.Store(ctx, "u", "s", "acct_1")
}

func TestLookupStoreIgnoreEmptyIdentifiers(t *testing.T) {
	a := New(nil, []string{"zenmux"})
	ctx := context.Background()
	for _, c := range []struct{ user, session string }{
		{"", "s"}, {"u", ""}, {"   ", "s"}, {"u", "  "},
	} {
		if id := a.Lookup(ctx, c.user, c.session); id != "" {
			t.Fatalf("Lookup(%q,%q) = %q, want empty", c.user, c.session, id)
		}
		a.Store(ctx, c.user, c.session, "acct_1")
	}
	a.Store(ctx, "u", "s", "   ")
}

func TestAffinityKeyFormat(t *testing.T) {
	got := affinityKey("user_1", "sess_1")
	want := "opendum:session-affinity:user_1:sess_1"
	if got != want {
		t.Fatalf("key = %q, want %q", got, want)
	}
	if !strings.HasPrefix(got, keyPrefix) {
		t.Fatalf("key %q missing prefix %q", got, keyPrefix)
	}
}

func TestRedisRoundtripSkippedWithoutRedis(t *testing.T) {
	client := redis.NewClient(&redis.Options{Addr: "127.0.0.1:6399", DialTimeout: 100 * time.Millisecond, MaxRetries: 1, PoolSize: 1})
	defer client.Close()
	if err := client.Ping(context.Background()).Err(); err != nil {
		t.Skipf("redis unavailable: %v", err)
	}
	ctx := context.Background()
	a := New(client, []string{"zenmux"})
	if id := a.Lookup(ctx, "u_rt", "s_rt"); id != "" {
		t.Fatalf("Lookup before Store = %q, want empty", id)
	}
	a.Store(ctx, "u_rt", "s_rt", "acct_rt")
	if id := a.Lookup(ctx, "u_rt", "s_rt"); id != "acct_rt" {
		t.Fatalf("Lookup after Store = %q, want acct_rt", id)
	}
}
