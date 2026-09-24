package psiphon

import (
	"context"
	_ "embed"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

//go:embed data/server_entries.txt
var embeddedServerEntries string

// notReadyWait bounds how long DialRegion waits for a region's first tunnel
// before failing, so a cold pool delays rather than drops an early request.
const notReadyWait = 30 * time.Second

// Pool owns one psiphon dialer per egress region and exposes the aggregate as
// a single Egress. Dials default to the preferred region (US by default) and
// rotate across that region's tunnels.
type Pool struct {
	mu        sync.RWMutex
	dialers   map[string]*dialer
	order     []string
	preferred string
	closeOnce sync.Once
	cancel    context.CancelFunc
}

// NewPool loads server entries and starts a dialer for every region. preferred
// is the ISO-3166 alpha-2 region that DialContext uses unless a caller asks
// for another one; it defaults to US.
func NewPool(preferred string) *Pool {
	preferred = strings.ToUpper(strings.TrimSpace(preferred))
	if preferred == "" {
		preferred = "US"
	}
	return &Pool{dialers: map[string]*dialer{}, preferred: preferred}
}

// Start loads the server list and brings up the per-region dialers. It is
// non-blocking: tunnels establish in the background and Ready reports once the
// preferred region has one.
func (p *Pool) Start(ctx context.Context) {
	initNotices()

	runCtx, cancel := context.WithCancel(context.WithoutCancel(ctx))
	p.mu.Lock()
	p.cancel = cancel
	p.mu.Unlock()

	raw := loadServerEntries(runCtx, embeddedServerEntries)
	byRegion := parseEntriesByRegion(raw)
	if len(byRegion) == 0 {
		slog.Error("psiphon: no server entries available")
		return
	}

	for region, entries := range byRegion {
		region := region
		entries := entries
		go func() {
			d, err := newDialer(runCtx, region, region, entries)
			if err != nil {
				slog.Error("psiphon: dialer init failed", "region", region, "error", err)
				return
			}
			p.mu.Lock()
			p.dialers[region] = d
			p.order = append(p.order, region)
			p.mu.Unlock()
		}()
	}

	slog.Info("psiphon: region pool starting", "regions", len(byRegion), "preferred", p.preferred)
}

// Ready reports whether the preferred region has at least one live tunnel.
func (p *Pool) Ready() bool {
	d := p.dialer(p.preferred)
	return d != nil && d.IsReady()
}

// ReadyRegion reports whether a specific region has a live tunnel.
func (p *Pool) ReadyRegion(region string) bool {
	d := p.dialer(region)
	return d != nil && d.IsReady()
}

// DialContext dials through the preferred region, falling back to any other
// ready region when it has none yet.
func (p *Pool) DialContext(ctx context.Context, network, addr string) (net.Conn, error) {
	if d := p.dialer(p.preferred); d != nil && d.IsReady() {
		return d.DialContext(ctx, network, addr)
	}
	for _, d := range p.readyDialers() {
		return d.DialContext(ctx, network, addr)
	}
	return nil, errNotReady
}

// DialRegion dials strictly through region. It never falls back to another
// region, so a caller that requires a specific egress country fails instead of
// leaking out of a different one. When the region's dialer exists but has no
// tunnel yet, it waits briefly for one so early requests do not fail while the
// pool is still establishing.
func (p *Pool) DialRegion(ctx context.Context, network, addr, region string) (net.Conn, error) {
	d := p.dialer(strings.ToUpper(strings.TrimSpace(region)))
	if d == nil {
		return nil, errNotReady
	}
	if !d.IsReady() {
		d = p.waitReady(ctx, d)
	}
	return d.DialContext(ctx, network, addr)
}

// waitReady blocks until d has a live tunnel or the wait budget runs out,
// returning the freshest dialer it observed.
func (p *Pool) waitReady(ctx context.Context, d *dialer) *dialer {
	deadline := time.Now().Add(notReadyWait)
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	for {
		if d.IsReady() || !time.Now().Before(deadline) {
			return d
		}
		select {
		case <-ctx.Done():
			return d
		case <-ticker.C:
		}
	}
}

// Rotate terminates one tunnel in the preferred region so the next dial exits
// from a fresh server/IP. Callers must also drop idle HTTP connections.
func (p *Pool) Rotate(context.Context) {
	p.RotateRegion(p.preferred)
}

// RotateRegion terminates one tunnel in region.
func (p *Pool) RotateRegion(region string) {
	if d := p.dialer(strings.ToUpper(strings.TrimSpace(region))); d != nil {
		d.rotate()
	}
}

// NewClient builds an HTTP client whose connections egress through the
// preferred region, falling back to any other ready region.
func (p *Pool) NewClient() *http.Client {
	return p.newClient(p.DialContext)
}

// NewClientRegion builds an HTTP client pinned strictly to region: it fails
// rather than leaking out of a different egress country.
func (p *Pool) NewClientRegion(region string) *http.Client {
	region = strings.ToUpper(strings.TrimSpace(region))
	return p.newClient(func(ctx context.Context, network, addr string) (net.Conn, error) {
		return p.DialRegion(ctx, network, addr, region)
	})
}

func (p *Pool) newClient(dial func(ctx context.Context, network, addr string) (net.Conn, error)) *http.Client {
	return &http.Client{
		Transport: &http.Transport{
			DialContext:           dial,
			ForceAttemptHTTP2:     false,
			MaxIdleConns:          10,
			MaxIdleConnsPerHost:   10,
			IdleConnTimeout:       90 * time.Second,
			TLSHandshakeTimeout:   15 * time.Second,
			ResponseHeaderTimeout: 60 * time.Second,
		},
	}
}

// Regions returns the regions with a dialer, sorted by name.
func (p *Pool) Regions() []string {
	p.mu.RLock()
	defer p.mu.RUnlock()
	out := make([]string, len(p.order))
	copy(out, p.order)
	return out
}

// Preferred returns the region DialContext uses by default.
func (p *Pool) Preferred() string { return p.preferred }

func (p *Pool) dialer(region string) *dialer {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.dialers[region]
}

// readyDialers returns every dialer with a live tunnel, preferred region
// first.
func (p *Pool) readyDialers() []*dialer {
	p.mu.RLock()
	defer p.mu.RUnlock()
	ready := make([]*dialer, 0, len(p.dialers))
	if preferred := p.dialers[p.preferred]; preferred != nil && preferred.IsReady() {
		ready = append(ready, preferred)
	}
	for region, d := range p.dialers {
		if region == p.preferred || !d.IsReady() {
			continue
		}
		ready = append(ready, d)
	}
	return ready
}

// Close stops every region dialer.
func (p *Pool) Close() {
	p.closeOnce.Do(func() {
		p.mu.RLock()
		cancel := p.cancel
		dialers := make([]*dialer, 0, len(p.dialers))
		for _, d := range p.dialers {
			dialers = append(dialers, d)
		}
		p.mu.RUnlock()
		if cancel != nil {
			cancel()
		}
		for _, d := range dialers {
			d.close()
		}
	})
}
