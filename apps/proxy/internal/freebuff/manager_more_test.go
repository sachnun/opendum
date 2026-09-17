package freebuff

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type freebuffRT func(*http.Request) (*http.Response, error)

func (f freebuffRT) RoundTrip(req *http.Request) (*http.Response, error) { return f(req) }

func TestReadySession(t *testing.T) {
	t.Parallel()
	now := time.Now()
	cases := []struct {
		name    string
		session *cachedSession
		model   string
		want    bool
	}{
		{"nil", nil, "m", false},
		{"active no model constraint", &cachedSession{status: statusActive, instanceID: "i"}, "m", true},
		{"active matching model", &cachedSession{status: statusActive, instanceID: "i", model: "m"}, "m", true},
		{"active mismatched model", &cachedSession{status: statusActive, instanceID: "i", model: "other"}, "m", false},
		{"active missing instance", &cachedSession{status: statusActive, model: "m"}, "m", false},
		{"active expiring soon", &cachedSession{status: statusActive, instanceID: "i", model: "m", expiresAt: now.Add(30 * time.Second)}, "m", false},
		{"active far expiry", &cachedSession{status: statusActive, instanceID: "i", model: "m", expiresAt: now.Add(5 * time.Minute)}, "m", true},
		{"queued", &cachedSession{status: statusQueued, instanceID: "i", model: "m"}, "m", false},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			id, ok := readySession(tc.session, now, tc.model)
			if ok != tc.want {
				t.Fatalf("ready = %v, want %v", ok, tc.want)
			}
			if ok && id == "" {
				t.Fatal("ready session returned empty instance id")
			}
		})
	}
}

func TestSleepCtx(t *testing.T) {
	t.Parallel()
	if err := sleepCtx(context.Background(), 0); err != nil {
		t.Fatalf("zero delay = %v", err)
	}
	if err := sleepCtx(context.Background(), time.Millisecond); err != nil {
		t.Fatalf("short delay = %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := sleepCtx(ctx, time.Hour); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled ctx = %v, want context.Canceled", err)
	}
}

func TestJitteredIdleTimeoutWithinRange(t *testing.T) {
	t.Parallel()
	for i := 0; i < 100; i++ {
		got := jitteredIdleTimeout()
		if got < idleSessionTimeoutMin || got >= idleSessionTimeoutMax {
			t.Fatalf("jittered timeout = %v, want within [%v, %v)", got, idleSessionTimeoutMin, idleSessionTimeoutMax)
		}
	}
}

func TestLeaseRelease(t *testing.T) {
	t.Parallel()
	var nilLease *Lease
	nilLease.Release()

	manager := NewManager(nil, nil)
	state := manager.state("acc")
	state.mu.Lock()
	lease := &Lease{account: state, held: true}
	lease.Release()
	if !state.mu.TryLock() {
		t.Fatal("lock was not released")
	}
	state.mu.Unlock()

	lease.Release()
}

func TestEnsureSessionReusesActiveSession(t *testing.T) {
	t.Parallel()
	client := &Client{baseURL: "http://unused", http: &http.Client{Transport: freebuffRT(func(*http.Request) (*http.Response, error) {
		t.Error("upstream should not be called for a ready session")
		return nil, errors.New("unexpected")
	})}}
	manager := NewManager(client, nil)
	state := manager.state("acc")
	state.session = &cachedSession{status: statusActive, instanceID: "inst_1", model: "m"}

	id, err := manager.ensureSession(context.Background(), state, "tok", "u", "m")
	if err != nil {
		t.Fatalf("ensureSession: %v", err)
	}
	if id != "inst_1" {
		t.Fatalf("id = %q, want inst_1", id)
	}
}

func TestEnsureSessionPollsQueuedUntilActive(t *testing.T) {
	t.Parallel()
	client := newSessionTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		_, _ = io.WriteString(w, `{"status":"active","instanceId":"inst_2","model":"m"}`)
	})
	manager := NewManager(client, nil)
	state := manager.state("acc")
	state.session = &cachedSession{status: statusQueued, instanceID: "inst_1", model: "m", retryAfter: time.Millisecond}

	id, err := manager.ensureSession(context.Background(), state, "tok", "u", "m")
	if err != nil {
		t.Fatalf("ensureSession: %v", err)
	}
	if id != "inst_2" {
		t.Fatalf("id = %q, want inst_2", id)
	}
	if state.session == nil || state.session.status != statusActive {
		t.Fatalf("session = %+v, want active", state.session)
	}
}

func TestPollQueuedTimeoutWithoutUpstream(t *testing.T) {
	t.Parallel()
	client := &Client{baseURL: "http://unused", http: &http.Client{Transport: freebuffRT(func(*http.Request) (*http.Response, error) {
		t.Error("poll should time out before calling upstream")
		return nil, errors.New("unexpected")
	})}}
	manager := NewManager(client, nil)
	state := manager.state("acc")
	state.session = &cachedSession{status: statusQueued, instanceID: "inst_1", model: "m", retryAfter: 2 * time.Minute}

	_, err := manager.pollQueued(context.Background(), state, "tok", "u", "m")
	var waiting *waitingRoomError
	if !errors.As(err, &waiting) {
		t.Fatalf("err = %v, want waitingRoomError", err)
	}
}

func TestRefreshSessionRetriesOnNoneStatus(t *testing.T) {
	t.Parallel()
	var posts int32
	client := newSessionTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		if atomic.AddInt32(&posts, 1) == 1 {
			_, _ = io.WriteString(w, `{"status":"none"}`)
			return
		}
		_, _ = io.WriteString(w, `{"status":"active","instanceId":"inst_1"}`)
	})
	manager := NewManager(client, nil)
	state := manager.state("acc")

	session, err := manager.refreshSession(context.Background(), state, "tok", "u", "m")
	if err != nil {
		t.Fatalf("refreshSession: %v", err)
	}
	if session.status != statusActive || session.instanceID != "inst_1" {
		t.Fatalf("session = %+v", session)
	}
	if posts != 2 {
		t.Fatalf("posts = %d, want 2 retries", posts)
	}
}

func TestRefreshSessionModelMismatch(t *testing.T) {
	t.Parallel()
	client := newSessionTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{"status":"active","instanceId":"i","model":"other"}`)
	})
	manager := NewManager(client, nil)
	state := manager.state("acc")

	_, err := manager.refreshSession(context.Background(), state, "tok", "u", "m")
	var locked *modelLockedError
	if !errors.As(err, &locked) {
		t.Fatalf("err = %v, want modelLockedError", err)
	}
}

func TestRefreshSessionMissingInstanceID(t *testing.T) {
	t.Parallel()
	client := newSessionTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{"status":"active"}`)
	})
	manager := NewManager(client, nil)
	state := manager.state("acc")

	if _, err := manager.refreshSession(context.Background(), state, "tok", "u", "m"); err == nil {
		t.Fatal("error = nil, want missing instanceId error")
	}
}

func TestRefreshSessionActiveParsesExpiryAndFallsBackModel(t *testing.T) {
	t.Parallel()
	client := newSessionTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{"status":"active","instanceId":"i","expiresAt":"2030-01-01T00:00:00Z"}`)
	})
	manager := NewManager(client, nil)
	state := manager.state("acc")

	session, err := manager.refreshSession(context.Background(), state, "tok", "u", "m")
	if err != nil {
		t.Fatalf("refreshSession: %v", err)
	}
	if session.model != "m" {
		t.Fatalf("model = %q, want fallback m", session.model)
	}
	if session.expiresAt.IsZero() {
		t.Fatal("expiry not parsed")
	}
}

func TestRefreshSessionBlockedStatuses(t *testing.T) {
	t.Parallel()
	t.Run("banned disables account", func(t *testing.T) {
		t.Parallel()
		client := newSessionTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
			_, _ = io.WriteString(w, `{"status":"banned"}`)
		})
		manager := NewManager(client, nil)
		state := manager.state("acc")
		if _, err := manager.refreshSession(context.Background(), state, "tok", "u", "m"); err == nil {
			t.Fatal("error = nil, want blocked error")
		}
		if !state.disabled {
			t.Fatal("account should be disabled after banned status")
		}
	})

	t.Run("rate limited sets cooldown", func(t *testing.T) {
		t.Parallel()
		client := newSessionTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
			_, _ = io.WriteString(w, `{"status":"rate_limited"}`)
		})
		manager := NewManager(client, nil)
		state := manager.state("acc")
		_, err := manager.refreshSession(context.Background(), state, "tok", "u", "m")
		var blocked *sessionBlockedError
		if !errors.As(err, &blocked) {
			t.Fatalf("err = %v, want sessionBlockedError", err)
		}
		if !state.cooldownUntil.After(time.Now()) {
			t.Fatal("cooldown not set for rate limited status")
		}
		if state.disabled {
			t.Fatal("account should not be disabled for rate limited status")
		}
	})
}

func TestPrepareReusesRunAndIncrementsStep(t *testing.T) {
	t.Parallel()
	var startRuns, sessions int32
	client := newSessionTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/api/v1/agent-runs":
			atomic.AddInt32(&startRuns, 1)
			_, _ = io.WriteString(w, `{"runId":"run_1"}`)
		case r.URL.Path == sessionPath && r.Method == http.MethodPost:
			atomic.AddInt32(&sessions, 1)
			_, _ = io.WriteString(w, `{"status":"active","instanceId":"inst_1"}`)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})
	manager := NewManager(client, nil)
	ctx := context.Background()

	lease, err := manager.Prepare(ctx, "acc", "tok", "u", "agent", "m")
	if err != nil {
		t.Fatalf("Prepare: %v", err)
	}
	if lease.RunID != "run_1" || lease.InstanceID != "inst_1" || lease.Step != 0 {
		t.Fatalf("lease = %+v", lease)
	}
	lease.Release()

	second, err := manager.Prepare(ctx, "acc", "tok", "u", "agent", "m")
	if err != nil {
		t.Fatalf("second Prepare: %v", err)
	}
	if second.RunID != "run_1" || second.Step != 1 {
		t.Fatalf("second lease = %+v, want reused run with step 1", second)
	}
	second.Release()

	if startRuns != 1 {
		t.Fatalf("startRuns = %d, want 1 reused run", startRuns)
	}
	if sessions != 1 {
		t.Fatalf("sessions = %d, want 1 reused session", sessions)
	}
}

func TestInvalidateSessionClearsCachedSession(t *testing.T) {
	t.Parallel()
	manager := NewManager(nil, nil)
	state := manager.state("acc")
	state.session = &cachedSession{status: statusActive, instanceID: "inst_1", model: "m"}

	manager.InvalidateSession("acc")
	if state.session != nil {
		t.Fatalf("session = %+v, want nil", state.session)
	}
}

func TestCooldownErrorFallbacks(t *testing.T) {
	t.Parallel()
	withReason := &cooldownError{reason: "too hot"}
	if got := withReason.Error(); got != "too hot" {
		t.Fatalf("reason error = %q", got)
	}
	withoutReason := &cooldownError{until: time.Now().Add(time.Minute)}
	if !strings.Contains(withoutReason.Error(), "cooling down") {
		t.Fatalf("default error = %q", withoutReason.Error())
	}
}
