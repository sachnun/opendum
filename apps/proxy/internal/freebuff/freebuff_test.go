package freebuff

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func TestBuildChatBodyInjectsBuffyAndMetadata(t *testing.T) {
	input := map[string]any{
		"model":    "deepseek/deepseek-v4-flash",
		"stream":   true,
		"messages": []any{map[string]any{"role": "user", "content": "hi"}},
	}
	body, err := BuildChatBody(input, "deepseek/deepseek-v4-flash", "run_1", "inst_1", "client_1", 2)
	if err != nil {
		t.Fatalf("BuildChatBody error: %v", err)
	}
	var parsed map[string]any
	if err := json.Unmarshal(body, &parsed); err != nil {
		t.Fatalf("decode: %v", err)
	}
	messages, _ := parsed["messages"].([]any)
	if len(messages) != 2 {
		t.Fatalf("messages = %d, want 2", len(messages))
	}
	first, _ := messages[0].(map[string]any)
	if first["role"] != "system" {
		t.Fatalf("first role = %v, want system", first["role"])
	}
	content, _ := first["content"].(string)
	if len(content) < len(buffySystemPromptOpening) || content[:len(buffySystemPromptOpening)] != buffySystemPromptOpening {
		t.Fatalf("system prompt does not open with the Buffy marker: %q", content)
	}
	metadata, _ := parsed["codebuff_metadata"].(map[string]any)
	if metadata["run_id"] != "run_1" || metadata["cost_mode"] != "free" || metadata["client_id"] != "client_1" {
		t.Fatalf("metadata = %#v", metadata)
	}
	if metadata["freebuff_instance_id"] != "inst_1" {
		t.Fatalf("freebuff_instance_id = %v, want inst_1", metadata["freebuff_instance_id"])
	}
	if metadata["n"] != float64(2) {
		t.Fatalf("n = %v, want 2", metadata["n"])
	}
	provider, _ := parsed["provider"].(map[string]any)
	if provider["allow_fallbacks"] != true {
		t.Fatalf("provider = %#v, want allow_fallbacks true", provider)
	}
	if _, mutated := input["codebuff_metadata"]; mutated {
		t.Fatal("input payload was mutated")
	}
}

func TestBuildChatBodyAppendsDecoyForCustomTools(t *testing.T) {
	input := map[string]any{
		"model":  "deepseek/deepseek-v4-flash",
		"stream": true,
		"tools":  []any{map[string]any{"type": "function", "function": map[string]any{"name": "my_custom_tool"}}},
	}
	body, err := BuildChatBody(input, "deepseek/deepseek-v4-flash", "run_1", "inst_1", "client_1", 0)
	if err != nil {
		t.Fatalf("BuildChatBody error: %v", err)
	}
	var parsed map[string]any
	_ = json.Unmarshal(body, &parsed)
	tools, _ := parsed["tools"].([]any)
	if len(tools) != 2 {
		t.Fatalf("tools = %d, want 2 (custom + decoy)", len(tools))
	}
	decoy, _ := tools[1].(map[string]any)
	fn, _ := decoy["function"].(map[string]any)
	if fn["name"] != "set_output" {
		t.Fatalf("decoy name = %v, want set_output", fn["name"])
	}
}

func TestBuildChatBodyKeepsApprovedTools(t *testing.T) {
	input := map[string]any{
		"model": "deepseek/deepseek-v4-flash",
		"tools": []any{map[string]any{"type": "function", "function": map[string]any{"name": "read_files"}}},
	}
	body, _ := BuildChatBody(input, "deepseek/deepseek-v4-flash", "run_1", "inst_1", "client_1", 0)
	var parsed map[string]any
	_ = json.Unmarshal(body, &parsed)
	if tools, _ := parsed["tools"].([]any); len(tools) != 1 {
		t.Fatalf("tools = %d, want 1 (no decoy for approved tools)", len(tools))
	}
}

func TestClassifyBlockedSession(t *testing.T) {
	apiErr, ok := Classify(&sessionBlockedError{status: string(statusCountryBlocked)})
	if !ok || apiErr.Status != http.StatusForbidden {
		t.Fatalf("classify country_blocked = %#v, ok=%v", apiErr, ok)
	}
	apiErr, ok = Classify(&sessionBlockedError{status: string(statusRateLimited), retryAfter: 0})
	if !ok || apiErr.Status != http.StatusTooManyRequests || apiErr.RetryAfter != rateLimitCooldown {
		t.Fatalf("classify rate_limited = %#v, ok=%v", apiErr, ok)
	}
	apiErr, ok = Classify(&waitingRoomError{retryAfter: 2 * time.Second})
	if !ok || apiErr.Status != http.StatusServiceUnavailable || apiErr.RetryAfter != 2*time.Second {
		t.Fatalf("classify waiting room = %#v, ok=%v", apiErr, ok)
	}
	if _, ok := Classify(errors.New("boom")); ok {
		t.Fatal("plain error should not classify")
	}
}

func TestParseRetryAfterHeader(t *testing.T) {
	header := http.Header{}
	header.Set("Retry-After", "42")
	if got := parseRetryAfter(header); got != 42*time.Second {
		t.Fatalf("retry-after seconds = %v", got)
	}
	header = http.Header{}
	header.Set("retry-after-ms", "1500")
	if got := parseRetryAfter(header); got != 1500*time.Millisecond {
		t.Fatalf("retry-after-ms = %v", got)
	}
}

func TestReadySessionRequiresModelMatch(t *testing.T) {
	future := time.Now().Add(time.Hour)
	session := &cachedSession{status: statusActive, instanceID: "inst", model: "model-a", expiresAt: future}
	if _, ok := readySession(session, time.Now(), "model-b"); ok {
		t.Fatal("active session must not be reused for a different model")
	}
	if id, ok := readySession(session, time.Now(), "model-a"); !ok || id != "inst" {
		t.Fatalf("ready session = %q, ok=%v", id, ok)
	}
}

func TestSnapshotStatus(t *testing.T) {
	active := &accountState{session: &cachedSession{status: statusActive, model: "deepseek-v4-flash", instanceID: "inst"}}
	snap := active.snapshot("acc")
	if snap.Status != "active" || snap.Model != "deepseek-v4-flash" || snap.InstanceID != "inst" || snap.AccountID != "acc" {
		t.Fatalf("active snapshot = %#v", snap)
	}

	queued := &accountState{session: &cachedSession{status: statusQueued, model: "m"}}
	if snap := queued.snapshot("acc"); snap.Status != "queued" {
		t.Fatalf("queued status = %q", snap.Status)
	}

	cooling := &accountState{cooldownUntil: time.Now().Add(time.Minute), lastError: "rate limited"}
	if snap := cooling.snapshot("acc"); snap.Status != "cooling" || snap.CooldownUntil == "" || snap.LastError != "rate limited" {
		t.Fatalf("cooling snapshot = %#v", snap)
	}

	disabled := &accountState{disabled: true}
	if snap := disabled.snapshot("acc"); snap.Status != "disabled" {
		t.Fatalf("disabled status = %q", snap.Status)
	}

	idle := &accountState{}
	if snap := idle.snapshot("acc"); snap.Status != "idle" {
		t.Fatalf("idle status = %q", snap.Status)
	}
}

func newIdleTestManager(t *testing.T, deletes *atomic.Int32) *Manager {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodDelete {
			deletes.Add(1)
		}
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(server.Close)
	return NewManager(&Client{baseURL: server.URL, http: server.Client()}, nil)
}

func seedIdleState(manager *Manager, accountID string, activity time.Time) *accountState {
	state := manager.state(accountID)
	state.mu.Lock()
	state.session = &cachedSession{status: statusActive, instanceID: "inst", model: "model-a"}
	state.token = "token"
	state.userID = "user"
	state.idleTimeout = 12 * time.Minute
	state.lastActivityAt = activity
	state.mu.Unlock()
	return state
}

func TestEndIdleSessionsEndsIdleActiveSession(t *testing.T) {
	var deletes atomic.Int32
	manager := newIdleTestManager(t, &deletes)
	state := seedIdleState(manager, "acc", time.Now().Add(-16*time.Minute))

	manager.EndIdleSessions(context.Background())

	if got := deletes.Load(); got != 1 {
		t.Fatalf("end session calls = %d, want 1", got)
	}
	state.mu.Lock()
	defer state.mu.Unlock()
	if state.session != nil {
		t.Fatal("idle session was not cleared")
	}
	if state.idleTimeout < idleSessionTimeoutMin || state.idleTimeout >= idleSessionTimeoutMax {
		t.Fatalf("idle timeout not re-rolled: %v", state.idleTimeout)
	}
	if got := state.snapshot("acc").Status; got != "idle" {
		t.Fatalf("snapshot status = %q, want idle", got)
	}
}

func TestEndIdleSessionsKeepsRecentlyUsedSession(t *testing.T) {
	var deletes atomic.Int32
	manager := newIdleTestManager(t, &deletes)
	state := seedIdleState(manager, "acc", time.Now().Add(-time.Minute))

	manager.EndIdleSessions(context.Background())

	if got := deletes.Load(); got != 0 {
		t.Fatalf("end session calls = %d, want 0", got)
	}
	state.mu.Lock()
	defer state.mu.Unlock()
	if state.session == nil {
		t.Fatal("recent session must be kept")
	}
}

func TestEndIdleSessionsSkipsInflightRequest(t *testing.T) {
	var deletes atomic.Int32
	manager := newIdleTestManager(t, &deletes)
	state := seedIdleState(manager, "acc", time.Now().Add(-16*time.Minute))

	state.mu.Lock()
	manager.EndIdleSessions(context.Background())
	state.mu.Unlock()

	if got := deletes.Load(); got != 0 {
		t.Fatalf("end session calls = %d, want 0", got)
	}
}

func TestEndIdleSessionsKeepsQueuedSession(t *testing.T) {
	var deletes atomic.Int32
	manager := newIdleTestManager(t, &deletes)
	state := seedIdleState(manager, "acc", time.Now().Add(-16*time.Minute))
	state.mu.Lock()
	state.session = &cachedSession{status: statusQueued, instanceID: "inst", model: "model-a"}
	state.mu.Unlock()

	manager.EndIdleSessions(context.Background())

	if got := deletes.Load(); got != 0 {
		t.Fatalf("end session calls = %d, want 0", got)
	}
}
