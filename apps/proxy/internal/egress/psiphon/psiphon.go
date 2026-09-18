package psiphon

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"

	"github.com/Psiphon-Labs/psiphon-tunnel-core/psiphon"
)

//go:embed data/server_entries.txt
var embeddedServerEntries string

var errNotReady = errors.New("psiphon: not ready")

const dialAttempts = 3

type Pool struct {
	mu         sync.RWMutex
	controller *psiphon.Controller
	cancel     context.CancelFunc
	target     int
	ready      atomic.Int32
	closeOnce  sync.Once
}

func NewPool(size int) *Pool {
	if size <= 0 {
		size = 3
	}
	return &Pool{target: size}
}

func (p *Pool) Start(ctx context.Context) {
	psiphon.SetNoticeWriter(psiphon.NewNoticeReceiver(p.onNotice))

	dataDir := filepath.Join(os.TempDir(), "opendum-psiphon")
	datastoreDir := filepath.Join(dataDir, "ca.Psiphon.PsiphonTunnel.tunnel-core", "datastore")
	if err := os.MkdirAll(datastoreDir, 0o755); err != nil {
		slog.Error("psiphon: datastore dir", "error", err)
		return
	}

	config, err := psiphon.LoadConfig(mustJSON(psiphonConfig(dataDir, p.target)))
	if err != nil {
		slog.Error("psiphon: load config", "error", err)
		return
	}
	if err := config.Commit(true); err != nil {
		slog.Error("psiphon: commit config", "error", err)
		return
	}
	if err := psiphon.OpenDataStore(config); err != nil {
		slog.Error("psiphon: open datastore", "error", err)
		return
	}

	runCtx, cancel := context.WithCancel(context.WithoutCancel(ctx))
	if err := psiphon.ImportEmbeddedServerEntries(runCtx, config, "", embeddedServerEntries); err != nil {
		slog.Warn("psiphon: import server entries", "error", err)
	}

	controller, err := psiphon.NewController(config)
	if err != nil {
		cancel()
		slog.Error("psiphon: new controller", "error", err)
		return
	}

	p.mu.Lock()
	p.controller = controller
	p.cancel = cancel
	p.mu.Unlock()

	go controller.Run(runCtx)
	slog.Info("psiphon: tunnel pool starting", "size", p.target)
}

func (p *Pool) onNotice(notice []byte) {
	var msg struct {
		Type string `json:"noticeType"`
	}
	if json.Unmarshal(notice, &msg) != nil {
		return
	}
	if msg.Type == "ActiveTunnel" {
		if int(p.ready.Add(1)) == p.target {
			slog.Info("psiphon: tunnels ready", "size", p.target)
		}
	}
}

func (p *Pool) Ready() bool { return p.ready.Load() > 0 }

// Rotate terminates one active tunnel so the next dial egresses from a fresh
// Psiphon server/IP. Idle HTTP connections must be closed separately so a new
// tunnel is actually used.
func (p *Pool) Rotate(context.Context) {
	p.mu.RLock()
	controller := p.controller
	p.mu.RUnlock()
	if controller == nil {
		return
	}
	controller.TerminateNextActiveTunnel()
}

func (p *Pool) DialContext(ctx context.Context, network, addr string) (net.Conn, error) {
	p.mu.RLock()
	controller := p.controller
	p.mu.RUnlock()
	if controller == nil || p.ready.Load() == 0 {
		return nil, errNotReady
	}
	var lastErr error
	for i := 0; i < dialAttempts; i++ {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		conn, err := controller.Dial(addr, nil)
		if err == nil {
			return conn, nil
		}
		lastErr = err
	}
	return nil, lastErr
}

func (p *Pool) NewClient() *http.Client {
	return &http.Client{
		Transport: &http.Transport{
			DialContext:           p.DialContext,
			ForceAttemptHTTP2:     false,
			MaxIdleConns:          10,
			MaxIdleConnsPerHost:   10,
			IdleConnTimeout:       90 * time.Second,
			TLSHandshakeTimeout:   15 * time.Second,
			ResponseHeaderTimeout: 60 * time.Second,
		},
	}
}

func (p *Pool) Close() {
	p.closeOnce.Do(func() {
		p.mu.RLock()
		cancel := p.cancel
		p.mu.RUnlock()
		if cancel != nil {
			cancel()
		}
	})
}

func psiphonConfig(dataDir string, size int) map[string]any {
	minIdle := size - 1
	if minIdle < 0 {
		minIdle = 0
	}
	sshWindowSize := 32
	return map[string]any{
		"LocalSocksProxyPort":            0,
		"LocalHttpProxyPort":             0,
		"PropagationChannelId":           "FFFFFFFFFFFFFFFF",
		"SponsorId":                      "FFFFFFFFFFFFFFFF",
		"EstablishTunnelTimeoutSeconds":  60,
		"TunnelPoolSize":                 size,
		"MaxTunnelPoolSize":              size,
		"MinIdleTunnels":                 minIdle,
		"DisableRemoteServerListFetcher": true,
		"DisableDSLFetcher":              true,
		"DataRootDirectory":              dataDir,
		"NetworkID":                      "WIFI",
		"EmitDiagnosticNotices":          true,
		"DisableTactics":                 true,
		"LimitMeekBufferSizes":           false,
		"LimitRelayBufferSizes":          false,
		"LimitCPUThreads":                true,
		"ConnectionWorkerPoolMaxSize":    4,
		"SSHChannelWindowSize":           &sshWindowSize,
		"DisableServerEntriesReporter":   true,
		"DisableReplay":                  true,
		"IgnoreHandshakeStatsRegexps":    true,
	}
}

func mustJSON(value any) []byte {
	data, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return data
}
