package tor

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	gonion "github.com/robogg133/gonion"
	"github.com/robogg133/gonion/pkg/common"
	"github.com/robogg133/gonion/pkg/path"
)

const (
	defaultPoolSize       = 3
	defaultCircuitHops    = 3
	defaultExitPort       = 443
	defaultDialTimeout    = 15 * time.Second
	defaultBuildTimeout   = 90 * time.Second
	defaultProbeTimeout   = 45 * time.Second
	defaultRefreshEvery   = 5 * time.Minute
	defaultBootstrapTries = 8
)

var dirAuthorities = []string{
	"86.59.21.38:443",
	"45.66.33.45:443",
	"131.188.40.189:443",
	"193.23.244.244:443",
	"171.25.193.9:80",
	"199.58.81.140:443",
	"204.13.164.118:443",
	"128.31.0.39:9101",
}

type managedCircuit struct {
	mu   sync.Mutex
	conn *gonion.Conn
	circ *gonion.Circuit
}

func (m *managedCircuit) alive() bool {
	if m == nil {
		return false
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.circ != nil && m.conn != nil && m.conn.Context().Err() == nil
}

func (m *managedCircuit) close() {
	if m == nil {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.circ != nil {
		_ = m.circ.Close()
		m.circ = nil
	}
	if m.conn != nil {
		_ = m.conn.Close()
		m.conn = nil
	}
}

func (m *managedCircuit) dial(ctx context.Context, addr string, dialTimeout time.Duration, buildTimeout time.Duration) (net.Conn, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.ensureLocked(ctx, dialTimeout, buildTimeout); err != nil {
		return nil, err
	}
	stream, err := m.circ.Dial(addr)
	if err == nil {
		return stream, nil
	}
	m.resetLocked()
	if err := m.ensureLocked(ctx, dialTimeout, buildTimeout); err != nil {
		return nil, err
	}
	return m.circ.Dial(addr)
}

func (m *managedCircuit) ensureLocked(ctx context.Context, dialTimeout time.Duration, buildTimeout time.Duration) error {
	if m.circ != nil && m.conn != nil && m.conn.Context().Err() == nil {
		return nil
	}
	m.resetLocked()
	cns := common.GetGlobalConsensus()
	if cns == nil {
		return fmt.Errorf("tor: no consensus")
	}
	sel := path.New(cns, false)
	if err := sel.SelectRandomCircuit(defaultCircuitHops, defaultExitPort); err != nil {
		return fmt.Errorf("tor: select path: %w", err)
	}
	relays := sel.Circuit()
	if len(relays) == 0 {
		return fmt.Errorf("tor: empty path")
	}
	guard := relays[0]
	dialCtx, cancel := context.WithTimeout(ctx, dialTimeout)
	defer cancel()
	var d net.Dialer
	raw, err := d.DialContext(dialCtx, "tcp", net.JoinHostPort(guard.Ipv4Addr, fmt.Sprintf("%d", guard.ORPort)))
	if err != nil {
		return fmt.Errorf("tor: dial guard: %w", err)
	}
	conn, err := gonion.NewConn(raw, io.Discard, false)
	if err != nil {
		_ = raw.Close()
		return fmt.Errorf("tor: link handshake: %w", err)
	}
	buildCtx, buildCancel := context.WithTimeout(ctx, buildTimeout)
	defer buildCancel()
	_ = buildCtx
	circ, err := conn.BuildPath(1, relays)
	if err != nil {
		_ = conn.Close()
		return fmt.Errorf("tor: build path: %w", err)
	}
	m.conn = conn
	m.circ = circ
	return nil
}

func (m *managedCircuit) resetLocked() {
	if m.circ != nil {
		_ = m.circ.Close()
		m.circ = nil
	}
	if m.conn != nil {
		_ = m.conn.Close()
		m.conn = nil
	}
}

type Pool struct {
	mu               sync.Mutex
	circuits         []*managedCircuit
	size             int
	bootstrapTimeout time.Duration
	buildTimeout     time.Duration
	dialTimeout      time.Duration
	refreshEvery     time.Duration
	started          bool
	closed           bool
	rr               atomic.Uint64
	refreshCancel    context.CancelFunc
}

func NewPool(size int, bootstrapTimeout time.Duration, buildTimeout time.Duration, dialTimeout time.Duration, refreshEvery time.Duration) *Pool {
	if size <= 0 {
		size = defaultPoolSize
	}
	if bootstrapTimeout <= 0 {
		bootstrapTimeout = defaultBuildTimeout
	}
	if buildTimeout <= 0 {
		buildTimeout = defaultBuildTimeout
	}
	if dialTimeout <= 0 {
		dialTimeout = defaultDialTimeout
	}
	if refreshEvery <= 0 {
		refreshEvery = defaultRefreshEvery
	}
	return &Pool{
		size:             size,
		bootstrapTimeout: bootstrapTimeout,
		buildTimeout:     buildTimeout,
		dialTimeout:      dialTimeout,
		refreshEvery:     refreshEvery,
	}
}

func (p *Pool) Start(ctx context.Context) {
	p.mu.Lock()
	if p.started || p.closed {
		p.mu.Unlock()
		return
	}
	p.started = true
	p.mu.Unlock()
	refreshCtx, cancel := context.WithCancel(context.WithoutCancel(ctx))
	p.mu.Lock()
	p.refreshCancel = cancel
	p.mu.Unlock()
	go p.run(refreshCtx)
}

func (p *Pool) run(ctx context.Context) {
	if common.GetGlobalConsensus() == nil {
		_ = p.bootstrap(ctx)
	}
	if common.GetGlobalConsensus() == nil {
		return
	}
	p.buildWarm(ctx)
	ticker := time.NewTicker(p.refreshEvery)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			p.refresh(ctx)
		}
	}
}

func (p *Pool) bootstrap(ctx context.Context) error {
	var lastErr error
	for _, addr := range dirAuthorities {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}
		raw, err := (&net.Dialer{Timeout: p.dialTimeout}).DialContext(ctx, "tcp", addr)
		if err != nil {
			lastErr = err
			continue
		}
		conn, err := gonion.NewConn(raw, io.Discard, false)
		if err != nil {
			_ = raw.Close()
			lastErr = err
			continue
		}
		err = gonion.BootstrapOneConn(conn)
		_ = conn.Close()
		if err != nil {
			lastErr = err
			continue
		}
		return nil
	}
	if lastErr == nil {
		lastErr = fmt.Errorf("tor: all authorities failed")
	}
	return lastErr
}

func (p *Pool) buildWarm(ctx context.Context) {
	ch := make(chan *managedCircuit, p.size)
	var wg sync.WaitGroup
	for i := 0; i < p.size; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			m := &managedCircuit{}
			bctx, cancel := context.WithTimeout(ctx, p.buildTimeout)
			err := m.ensureLocked(bctx, p.dialTimeout, p.buildTimeout)
			cancel()
			if err != nil {
				m.close()
				return
			}
			ch <- m
		}()
	}
	wg.Wait()
	close(ch)
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		for m := range ch {
			m.close()
		}
		return
	}
	for m := range ch {
		if m != nil {
			p.circuits = append(p.circuits, m)
		}
	}
}

func (p *Pool) refresh(ctx context.Context) {
	p.mu.Lock()
	if p.closed || len(p.circuits) == 0 {
		needsBuild := !p.closed && len(p.circuits) == 0 && common.GetGlobalConsensus() != nil
		p.mu.Unlock()
		if needsBuild {
			p.buildWarm(ctx)
		}
		return
	}
	circuits := append([]*managedCircuit(nil), p.circuits...)
	p.mu.Unlock()
	for _, m := range circuits {
		if m.alive() {
			continue
		}
		bctx, cancel := context.WithTimeout(ctx, p.buildTimeout)
		_, _ = m.dial(bctx, "1.1.1.1:80", p.dialTimeout, p.buildTimeout)
		cancel()
	}
}

func (p *Pool) Ready() bool {
	return p.HealthyCount() > 0
}

func (p *Pool) HealthyCount() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	n := 0
	for _, m := range p.circuits {
		if m != nil && m.circ != nil && m.conn != nil && m.conn.Context().Err() == nil {
			n++
		}
	}
	return n
}

func (p *Pool) TotalCount() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.circuits)
}

func (p *Pool) DialContext(ctx context.Context, network string, addr string) (net.Conn, error) {
	p.mu.Lock()
	if p.closed || len(p.circuits) == 0 {
		p.mu.Unlock()
		return nil, fmt.Errorf("tor: pool not ready")
	}
	circuits := append([]*managedCircuit(nil), p.circuits...)
	p.mu.Unlock()
	start := int(p.rr.Add(1))
	var lastErr error
	for i := 0; i < len(circuits); i++ {
		m := circuits[(start+i)%len(circuits)]
		if m == nil {
			continue
		}
		conn, err := m.dial(ctx, addr, p.dialTimeout, p.buildTimeout)
		if err == nil {
			return conn, nil
		}
		lastErr = err
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		default:
		}
	}
	if lastErr == nil {
		lastErr = fmt.Errorf("tor: no circuit available")
	}
	return nil, lastErr
}

func (p *Pool) NewClient() *http.Client {
	return &http.Client{
		Timeout: 0,
		Transport: &http.Transport{
			DialContext:           p.DialContext,
			ForceAttemptHTTP2:     false,
			MaxIdleConns:          10,
			IdleConnTimeout:       90 * time.Second,
			TLSHandshakeTimeout:   15 * time.Second,
			ResponseHeaderTimeout: 60 * time.Second,
		},
	}
}

func (p *Pool) Close() {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return
	}
	p.closed = true
	if p.refreshCancel != nil {
		p.refreshCancel()
	}
	for _, m := range p.circuits {
		if m != nil {
			m.close()
		}
	}
	p.circuits = nil
}
