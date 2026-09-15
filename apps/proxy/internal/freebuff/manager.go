package freebuff

import (
	"context"
	"crypto/rand"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

type Manager struct {
	client   *Client
	redis    *redis.Client
	mu       sync.Mutex
	accounts map[string]*accountState
}

type accountState struct {
	id            string
	mu            sync.Mutex
	session       *cachedSession
	runs          map[string]*runState
	cooldownUntil time.Time
	disabled      bool
	lastError     string
	clientID      string
}

type runState struct {
	id    string
	steps int
}

type Lease struct {
	RunID      string
	InstanceID string
	Step       int
	ClientID   string

	account *accountState
	held    bool
}

func (l *Lease) Release() {
	if l == nil || !l.held || l.account == nil {
		return
	}
	l.held = false
	l.account.mu.Unlock()
}

func NewManager(client *Client, redisClient *redis.Client) *Manager {
	return &Manager{client: client, redis: redisClient, accounts: map[string]*accountState{}}
}

func (m *Manager) state(accountID string) *accountState {
	m.mu.Lock()
	defer m.mu.Unlock()
	state, ok := m.accounts[accountID]
	if !ok {
		state = &accountState{id: accountID, runs: map[string]*runState{}, clientID: newClientID()}
		m.accounts[accountID] = state
	}
	return state
}

func (m *Manager) Prepare(ctx context.Context, accountID, token, userID, agent, model string) (*Lease, error) {
	if strings.TrimSpace(agent) == "" {
		return nil, fmt.Errorf("freebuff: model %q has no upstream agent configured", model)
	}
	state := m.state(accountID)
	state.mu.Lock()

	if state.disabled {
		err := state.lastError
		snap := state.snapshot(accountID)
		state.mu.Unlock()
		m.store(snap)
		if err == "" {
			err = "freebuff account is disabled"
		}
		return nil, fmt.Errorf("%s", err)
	}
	if now := time.Now(); now.Before(state.cooldownUntil) {
		remaining := time.Until(state.cooldownUntil)
		snap := state.snapshot(accountID)
		err := &cooldownError{until: state.cooldownUntil, retryAfter: remaining, reason: state.lastError}
		state.mu.Unlock()
		m.store(snap)
		return nil, err
	}

	run := state.runs[agent]
	if run == nil {
		runID, err := m.client.StartRun(ctx, token, userID, agent)
		if err != nil {
			state.lastError = err.Error()
			if isBannedMessage(err.Error()) {
				state.disabled = true
			}
			snap := state.snapshot(accountID)
			state.mu.Unlock()
			m.store(snap)
			return nil, err
		}
		run = &runState{id: runID}
		state.runs[agent] = run
	}

	instanceID, err := m.ensureSession(ctx, state, token, userID, model)
	if err != nil {
		snap := state.snapshot(accountID)
		state.mu.Unlock()
		m.store(snap)
		return nil, err
	}

	step := run.steps
	run.steps++
	snap := state.snapshot(accountID)
	m.store(snap)
	return &Lease{RunID: run.id, InstanceID: instanceID, Step: step, ClientID: state.clientID, account: state, held: true}, nil
}

func (m *Manager) InvalidateSession(accountID string) {
	state := m.state(accountID)
	state.mu.Lock()
	state.session = nil
	snap := state.snapshot(accountID)
	state.mu.Unlock()
	m.store(snap)
}

func (m *Manager) ensureSession(ctx context.Context, state *accountState, token, userID, model string) (string, error) {
	model = strings.TrimSpace(model)
	if cached, ready := readySession(state.session, time.Now(), model); ready {
		return cached, nil
	}
	if state.session != nil && state.session.status == statusQueued && state.session.model == model {
		return m.pollQueued(ctx, state, token, userID, model)
	}

	session, err := m.refreshSession(ctx, state, token, userID, model)
	if err != nil {
		return "", err
	}
	if session.status == statusQueued {
		_ = session
		return m.pollQueued(ctx, state, token, userID, model)
	}
	return session.instanceID, nil
}

func (m *Manager) refreshSession(ctx context.Context, state *accountState, token, userID, model string) (*cachedSession, error) {
	state.session = nil
	stateResponse, err := m.client.CreateOrRefreshSession(ctx, token, userID, model)
	if err != nil {
		state.lastError = err.Error()
		return nil, err
	}

	retriedSwitch := false
	for {
		switch sessionStatus(strings.TrimSpace(stateResponse.Status)) {
		case statusActive:
			if mismatch(stateResponse, model) {
				return nil, &modelLockedError{current: strings.TrimSpace(stateResponse.Model), target: model}
			}
			instanceID := strings.TrimSpace(stateResponse.InstanceID)
			if instanceID == "" {
				return nil, fmt.Errorf("freebuff: active session missing instanceId")
			}
			session := &cachedSession{
				status:     statusActive,
				instanceID: instanceID,
				model:      firstNonEmpty(strings.TrimSpace(stateResponse.Model), model),
				expiresAt:  parseOptionalTime(stateResponse.ExpiresAt),
				retryAfter: stateResponse.retryAfter,
			}
			state.session = session
			state.lastError = ""
			return session, nil
		case statusQueued:
			if mismatch(stateResponse, model) {
				return nil, &modelLockedError{current: strings.TrimSpace(stateResponse.Model), target: model}
			}
			instanceID := strings.TrimSpace(stateResponse.InstanceID)
			if instanceID == "" {
				return nil, fmt.Errorf("freebuff: queued session missing instanceId")
			}
			session := &cachedSession{
				status:     statusQueued,
				instanceID: instanceID,
				model:      firstNonEmpty(strings.TrimSpace(stateResponse.Model), model),
				retryAfter: queuedPollDelay(stateResponse),
			}
			state.session = session
			return session, nil
		case statusNone, statusEnded, statusSuperseded:
			stateResponse, err = m.client.CreateOrRefreshSession(ctx, token, userID, model)
			if err != nil {
				state.lastError = err.Error()
				return nil, err
			}
		case statusModelLocked:
			if retriedSwitch {
				return nil, &sessionBlockedError{status: string(statusModelLocked), retryAfter: stateResponse.retryAfter}
			}
			retriedSwitch = true
			_ = m.client.EndSession(ctx, token, userID)
			stateResponse, err = m.client.CreateOrRefreshSession(ctx, token, userID, model)
			if err != nil {
				state.lastError = err.Error()
				return nil, err
			}
		case statusDisabled:
			return nil, &sessionBlockedError{status: string(statusDisabled)}
		case statusModelUnavailable, statusRateLimited, statusSpendLimited, statusIPCapped, statusCountryBlocked, statusBanned:
			blocked := &sessionBlockedError{status: string(sessionStatus(strings.TrimSpace(stateResponse.Status))), retryAfter: stateResponse.retryAfter}
			if cooldown := blocked.cooldown(); cooldown > 0 {
				state.cooldownUntil = time.Now().Add(cooldown)
			}
			if blocked.status == string(statusBanned) {
				state.disabled = true
			}
			state.lastError = blocked.Error()
			return nil, blocked
		default:
			return nil, fmt.Errorf("freebuff: unexpected session status %q", stateResponse.Status)
		}
	}
}

func (m *Manager) pollQueued(ctx context.Context, state *accountState, token, userID, model string) (string, error) {
	deadline := time.Now().Add(maxWaitingRoomWait)
	for {
		session := state.session
		if session == nil || session.status != statusQueued {
			return "", &waitingRoomError{}
		}
		delay := session.retryAfter
		if delay <= 0 {
			delay = pollInterval
		}
		if time.Now().Add(delay).After(deadline) {
			return "", &waitingRoomError{retryAfter: delay}
		}
		if err := sleepCtx(ctx, delay); err != nil {
			return "", err
		}
		stateResponse, err := m.client.GetSession(ctx, token, userID, session.instanceID)
		if err != nil {
			return "", err
		}
		if mismatch(stateResponse, model) {
			return "", &modelLockedError{current: strings.TrimSpace(stateResponse.Model), target: model}
		}
		switch sessionStatus(strings.TrimSpace(stateResponse.Status)) {
		case statusActive:
			instanceID := strings.TrimSpace(stateResponse.InstanceID)
			if instanceID == "" {
				instanceID = session.instanceID
			}
			state.session = &cachedSession{
				status:     statusActive,
				instanceID: instanceID,
				model:      firstNonEmpty(strings.TrimSpace(stateResponse.Model), model),
				expiresAt:  parseOptionalTime(stateResponse.ExpiresAt),
			}
			return instanceID, nil
		case statusQueued:
			session.retryAfter = queuedPollDelay(stateResponse)
		case statusEnded, statusSuperseded, statusNone:
			state.session = nil
			return "", &waitingRoomError{}
		default:
			blocked := &sessionBlockedError{status: string(sessionStatus(strings.TrimSpace(stateResponse.Status))), retryAfter: stateResponse.retryAfter}
			if cooldown := blocked.cooldown(); cooldown > 0 {
				state.cooldownUntil = time.Now().Add(cooldown)
			}
			state.session = nil
			state.lastError = blocked.Error()
			return "", blocked
		}
	}
}

func readySession(session *cachedSession, now time.Time, model string) (string, bool) {
	if session == nil {
		return "", false
	}
	switch session.status {
	case statusActive:
		if session.model != "" && session.model != model {
			return "", false
		}
		if session.instanceID == "" {
			return "", false
		}
		if session.expiresAt.IsZero() || now.Before(session.expiresAt.Add(-60*time.Second)) {
			return session.instanceID, true
		}
	}
	return "", false
}

func mismatch(state freeSessionResponse, requestedModel string) bool {
	status := sessionStatus(strings.TrimSpace(state.Status))
	if status != statusActive && status != statusQueued {
		return false
	}
	actual := strings.TrimSpace(state.Model)
	return requestedModel != "" && actual != "" && actual != requestedModel
}

func queuedPollDelay(state freeSessionResponse) time.Duration {
	if state.EstimatedWaitMs <= 0 {
		return pollInterval
	}
	delay := time.Duration(state.EstimatedWaitMs) * time.Millisecond
	if delay < time.Second {
		return time.Second
	}
	if delay > pollInterval {
		return pollInterval
	}
	return delay
}

func isBannedMessage(message string) bool {
	lower := strings.ToLower(message)
	return strings.Contains(lower, "banned") || strings.Contains(lower, "account_banned") || strings.Contains(lower, "banned_user")
}

func newClientID() string {
	const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz"
	buf := make([]byte, 10)
	if _, err := rand.Read(buf); err != nil {
		return "0000000000000"
	}
	out := make([]byte, 13)
	for i := range out {
		out[i] = alphabet[int(buf[i%len(buf)])%36]
	}
	return string(out)
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func sleepCtx(ctx context.Context, delay time.Duration) error {
	if delay <= 0 {
		return nil
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

type cooldownError struct {
	until      time.Time
	retryAfter time.Duration
	reason     string
}

func (e *cooldownError) Error() string {
	if e.reason != "" {
		return e.reason
	}
	return fmt.Sprintf("freebuff account cooling down until %s", e.until.Format(time.RFC3339))
}
