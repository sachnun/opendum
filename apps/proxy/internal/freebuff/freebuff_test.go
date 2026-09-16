package freebuff

import (
	"context"
	"encoding/json"
	"errors"
	"io"
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

func TestIsSessionInvalidCodes(t *testing.T) {
	valid := []string{
		"waiting_room_required",
		"waiting_room_queued",
		"session_superseded",
		"session_expired",
		"session_model_mismatch",
		"freebuff_update_required",
		"free_mode_invalid_agent_hierarchy",
		"free_mode_cli_required",
	}
	for _, code := range valid {
		body, _ := json.Marshal(map[string]any{"error": code, "message": "nope"})
		if !IsSessionInvalid(http.StatusForbidden, body) {
			t.Fatalf("code %q must invalidate the session", code)
		}
	}
	if IsSessionInvalid(http.StatusForbidden, []byte(`{"error":"session_limit_reached"}`)) {
		t.Fatal("session_limit_reached must not invalidate the session")
	}
	if IsSessionInvalid(http.StatusOK, nil) {
		t.Fatal("success status must not invalidate the session")
	}
	if !IsSessionInvalid(http.StatusUpgradeRequired, nil) {
		t.Fatal("426 must invalidate the session")
	}
}

func TestIsTurnLimit(t *testing.T) {
	cases := []struct {
		status int
		body   string
		want   bool
	}{
		{http.StatusTooManyRequests, `{"error":"turn_spend_limit"}`, true},
		{http.StatusTooManyRequests, `{"error":{"message":"turn_spend_limit reached"}}`, true},
		{http.StatusTooManyRequests, `{"error":"turn_end_limit"}`, true},
		{http.StatusTooManyRequests, `{"error":"free_mode_rate_limited"}`, false},
		{http.StatusOK, `{"error":"turn_spend_limit"}`, false},
	}
	for _, tc := range cases {
		if got := IsTurnLimit(tc.status, []byte(tc.body)); got != tc.want {
			t.Fatalf("IsTurnLimit(%d, %s) = %v, want %v", tc.status, tc.body, got, tc.want)
		}
	}
}

func TestCapacityDeferredRetry(t *testing.T) {
	header := http.Header{}
	header.Set("Retry-After", "5")
	body := []byte(`{"error":"free_mode_capacity_deferred"}`)
	if delay, ok := CapacityDeferredRetry(http.StatusTooManyRequests, header, body); !ok || delay != 5*time.Second {
		t.Fatalf("retry-after hint = %v, ok=%v", delay, ok)
	}
	if delay, ok := CapacityDeferredRetry(http.StatusTooManyRequests, http.Header{}, body); !ok || delay != capacityDeferredCooldown {
		t.Fatalf("default cooldown = %v, ok=%v", delay, ok)
	}
	if _, ok := CapacityDeferredRetry(http.StatusOK, header, body); ok {
		t.Fatal("200 must not classify as capacity deferred")
	}
	if _, ok := CapacityDeferredRetry(http.StatusTooManyRequests, header, []byte(`{"error":"free_mode_rate_limited"}`)); ok {
		t.Fatal("other 429 codes must not classify as capacity deferred")
	}
}

func TestDailyQuotaCooldown(t *testing.T) {
	body := []byte(`{"error":{"message":"free-models-per-day-high-balance"}}`)
	if delay, ok := DailyQuotaCooldown(http.StatusTooManyRequests, body); !ok || delay != dailyQuotaCooldown {
		t.Fatalf("daily quota cooldown = %v, ok=%v", delay, ok)
	}
	if _, ok := DailyQuotaCooldown(http.StatusTooManyRequests, []byte(`{"error":"free_mode_rate_limited"}`)); ok {
		t.Fatal("rate limit must not classify as daily quota")
	}
}

func TestRotateRunFinishesCurrentRun(t *testing.T) {
	var got []byte
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got, _ = io.ReadAll(r.Body)
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()
	manager := NewManager(&Client{baseURL: server.URL, http: server.Client()}, nil)
	state := manager.state("acc")
	state.mu.Lock()
	state.runs["agent1"] = &runState{id: "run_1", steps: 3}
	state.token = "token"
	state.userID = "user"
	state.mu.Unlock()

	manager.RotateRun(context.Background(), "acc", "agent1")

	var payload map[string]any
	if err := json.Unmarshal(got, &payload); err != nil {
		t.Fatalf("finish run payload: %v (%s)", err, got)
	}
	if payload["action"] != "FINISH" || payload["runId"] != "run_1" || payload["totalSteps"] != float64(3) {
		t.Fatalf("finish run payload = %#v", payload)
	}
	state.mu.Lock()
	defer state.mu.Unlock()
	if len(state.runs) != 0 {
		t.Fatalf("runs after rotation = %#v", state.runs)
	}
}

func TestRotateRunWithoutRunSkipsRequest(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()
	manager := NewManager(&Client{baseURL: server.URL, http: server.Client()}, nil)

	manager.RotateRun(context.Background(), "acc", "agent1")

	if got := calls.Load(); got != 0 {
		t.Fatalf("finish run calls = %d, want 0", got)
	}
}

func TestCooldownBlocksPrepare(t *testing.T) {
	manager := NewManager(nil, nil)
	manager.Cooldown("acc", time.Minute, "parked")

	_, err := manager.Prepare(context.Background(), "acc", "token", "", "agent1", "model-a")
	var cd *cooldownError
	if !errors.As(err, &cd) {
		t.Fatalf("prepare error = %v, want cooldownError", err)
	}
	if snap := manager.state("acc").snapshot("acc"); snap.Status != "cooling" || snap.LastError != "parked" {
		t.Fatalf("snapshot = %#v", snap)
	}
}

func TestEndIdleSessionsSendsInstanceID(t *testing.T) {
	var instances []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		instances = append(instances, r.Header.Get("x-freebuff-instance-id"))
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ended"}`))
	}))
	defer server.Close()
	manager := NewManager(&Client{baseURL: server.URL, http: server.Client()}, nil)
	state := seedIdleState(manager, "acc", time.Now().Add(-16*time.Minute))

	manager.EndIdleSessions(context.Background())

	if len(instances) != 1 || instances[0] != "inst" {
		t.Fatalf("instance headers = %v, want [inst]", instances)
	}
	state.mu.Lock()
	defer state.mu.Unlock()
	if state.session != nil {
		t.Fatal("ended session was not cleared")
	}
}

func TestEndIdleSessionsKeepsSessionWhenDeleteFails(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"error":"instance_required"}`))
	}))
	defer server.Close()
	manager := NewManager(&Client{baseURL: server.URL, http: server.Client()}, nil)
	state := seedIdleState(manager, "acc", time.Now().Add(-16*time.Minute))

	manager.EndIdleSessions(context.Background())

	state.mu.Lock()
	defer state.mu.Unlock()
	if state.session == nil {
		t.Fatal("session must be kept when the upstream refuses the delete")
	}
	if snap := state.snapshot("acc"); snap.Status != "active" {
		t.Fatalf("snapshot status = %q, want active", snap.Status)
	}
}

func TestClientUserAgentFollowsPublishedVersion(t *testing.T) {
	previous, had := clientVersion.Load().(string)
	t.Cleanup(func() {
		if had {
			clientVersion.Store(previous)
			return
		}
		clientVersion.Store("")
	})
	clientVersion.Store("")
	if got := ClientUserAgent(); got != "Freebuff-CLI/"+clientVersionFallback {
		t.Fatalf("fallback user agent = %q", got)
	}
	clientVersion.Store("9.9.9")
	if got := ClientUserAgent(); got != "Freebuff-CLI/9.9.9" {
		t.Fatalf("published user agent = %q", got)
	}
}

func TestCooldownIgnoresNonPositiveDuration(t *testing.T) {
	manager := NewManager(nil, nil)
	manager.Cooldown("acc", 0, "noop")
	if snap := manager.state("acc").snapshot("acc"); snap.Status != "idle" {
		t.Fatalf("snapshot status = %q, want idle", snap.Status)
	}
}

func newSessionTestClient(t *testing.T, handler http.HandlerFunc) *Client {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	return &Client{baseURL: server.URL, http: server.Client()}
}

func TestSessionPostUsesLegacyPath(t *testing.T) {
	var paths, wallet, models []string
	client := newSessionTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.Method+" "+r.URL.Path)
		wallet = append(wallet, r.Header.Get("x-freebuff-wallet-spend-limit"))
		models = append(models, r.Header.Get("x-freebuff-model"))
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"active","instanceId":"inst_1","model":"m"}`))
	})

	session, err := client.CreateOrRefreshSession(context.Background(), "token", "user", "m")
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	if session.Status != string(statusActive) || session.InstanceID != "inst_1" {
		t.Fatalf("session = %#v", session)
	}
	if len(paths) != 1 || paths[0] != "POST "+sessionPath {
		t.Fatalf("paths = %v, want POST %s", paths, sessionPath)
	}
	if wallet[0] != "" {
		t.Fatalf("wallet header = %q, want empty", wallet[0])
	}
	if models[0] != "m" {
		t.Fatalf("model header = %q, want m", models[0])
	}
}

func TestSessionPostUnsupportedReportsError(t *testing.T) {
	client := newSessionTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusMethodNotAllowed)
	})

	_, err := client.CreateOrRefreshSession(context.Background(), "token", "user", "m")
	var requestErr *sessionRequestError
	if !errors.As(err, &requestErr) {
		t.Fatalf("error = %v, want sessionRequestError", err)
	}
	if apiErr, ok := Classify(err); !ok || apiErr.Status != http.StatusMethodNotAllowed {
		t.Fatalf("classify = %#v, ok=%v", apiErr, ok)
	}
}

func TestSessionGetNotFoundIsNone(t *testing.T) {
	client := newSessionTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != sessionPath {
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		w.WriteHeader(http.StatusNotFound)
	})

	session, err := client.GetSession(context.Background(), "token", "user", "inst_1")
	if err != nil {
		t.Fatalf("get session: %v", err)
	}
	if session.Status != string(statusNone) {
		t.Fatalf("status = %q, want %q", session.Status, statusNone)
	}
}

func TestSessionStatusClassification(t *testing.T) {
	cases := []struct {
		status   sessionStatus
		wantCode int
		wantWait time.Duration
	}{
		{statusConsentRequired, http.StatusConflict, 0},
		{statusSessionLimitReached, http.StatusConflict, dailyQuotaCooldown},
		{statusModelUnavailable, http.StatusConflict, modelUnavailableCooldown},
		{statusRateLimited, http.StatusTooManyRequests, rateLimitCooldown},
		{statusCountryBlocked, http.StatusForbidden, countryBlockedCooldown},
	}
	for _, tc := range cases {
		apiErr, ok := Classify(&sessionBlockedError{status: string(tc.status)})
		if !ok {
			t.Fatalf("status %q did not classify", tc.status)
		}
		if apiErr.Status != tc.wantCode || apiErr.RetryAfter != tc.wantWait {
			t.Fatalf("status %q -> %d/%v, want %d/%v", tc.status, apiErr.Status, apiErr.RetryAfter, tc.wantCode, tc.wantWait)
		}
	}
}

func TestEndSessionReportsRefundSettlement(t *testing.T) {
	client := newSessionTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ended","freebucksRefundPending":true}`))
	})

	result, err := client.EndSession(context.Background(), "token", "user", "inst_1")
	if err != nil {
		t.Fatalf("end session: %v", err)
	}
	if result.Status != "ended" || !result.RefundPending || result.Refund != 0 {
		t.Fatalf("result = %#v, want pending refund", result)
	}

	settled := newSessionTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ended","freebucksRefundPending":false,"freebucksRefund":4.5}`))
	})
	result, err = settled.EndSession(context.Background(), "token", "user", "inst_1")
	if err != nil {
		t.Fatalf("end session: %v", err)
	}
	if result.RefundPending || result.Refund != 4.5 {
		t.Fatalf("result = %#v, want settled refund of 4.5", result)
	}
}

func TestEndSessionSettlesPendingRefund(t *testing.T) {
	previousInterval := refundSettlementInterval
	refundSettlementInterval = 5 * time.Millisecond
	t.Cleanup(func() { refundSettlementInterval = previousInterval })

	var deletes atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if deletes.Add(1) == 1 {
			_, _ = w.Write([]byte(`{"status":"ended","freebucksRefundPending":true}`))
			return
		}
		_, _ = w.Write([]byte(`{"status":"ended","freebucksRefund":4.5}`))
	}))
	t.Cleanup(server.Close)

	manager := NewManager(&Client{baseURL: server.URL, http: server.Client()}, nil)
	seedIdleState(manager, "acc", time.Now().Add(-16*time.Minute))

	manager.EndIdleSessions(context.Background())

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && deletes.Load() < 2 {
		time.Sleep(5 * time.Millisecond)
	}
	if got := deletes.Load(); got != 2 {
		t.Fatalf("end session calls = %d, want 2 (initial delete plus one settlement)", got)
	}
	time.Sleep(50 * time.Millisecond)
	if got := deletes.Load(); got != 2 {
		t.Fatalf("settlement kept retrying after the refund settled: %d calls", got)
	}
}
