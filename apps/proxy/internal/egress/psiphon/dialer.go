package psiphon

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"math/rand"
	"net"
	"os"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/Psiphon-Labs/psiphon-tunnel-core/psiphon"
	"github.com/Psiphon-Labs/psiphon-tunnel-core/psiphon/common"
	"github.com/Psiphon-Labs/psiphon-tunnel-core/psiphon/common/protocol"
)

const (
	// MaxTunnelsPerRegion caps how many parallel tunnels one region runs. More
	// tunnels raise the chance a dial succeeds and spread load across exit IPs
	// without fanning out unbounded.
	MaxTunnelsPerRegion = 3

	dialAttempts = 3

	// tunnelRefreshInterval terminates one tunnel periodically so exits rotate
	// instead of pinning to the same server/IP for the life of the process.
	tunnelRefreshInterval = 5 * time.Minute
)

var errNotReady = errors.New("psiphon: not ready")

// dialer runs one psiphon controller pinned to a single egress region.
type dialer struct {
	id          string
	region      string
	controller  *psiphon.Controller
	cancel      context.CancelFunc
	targetPool  int
	tunnelReady atomic.Int32
	serverIDs   map[string]struct{}
}

// DialContext opens a tunneled connection, returning errNotReady until the
// first tunnel for the region is up so callers can fail over quickly.
func (d *dialer) DialContext(ctx context.Context, network, addr string) (net.Conn, error) {
	if d == nil || d.controller == nil {
		return nil, errNotReady
	}
	if d.tunnelReady.Load() == 0 && d.targetPool > 0 {
		return nil, errNotReady
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	var lastErr error
	for i := 0; i < dialAttempts; i++ {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		conn, err := d.controller.Dial(addr, nil)
		if err == nil {
			return conn, nil
		}
		lastErr = err
	}
	return nil, lastErr
}

func (d *dialer) IsReady() bool { return d != nil && d.tunnelReady.Load() > 0 }

// activeTunnels reports how many tunnels the controller currently holds. The
// refresh loop uses it to avoid terminating a pool that has not finished
// establishing. The controller exposes no public count, so the unexported
// tunnels slice is read reflectively.
func (d *dialer) activeTunnels() int {
	if d == nil || d.controller == nil {
		return 0
	}
	value := reflect.ValueOf(d.controller)
	if value.Kind() != reflect.Ptr || value.IsNil() {
		return 0
	}
	tunnels := value.Elem().FieldByName("tunnels")
	if !tunnels.IsValid() || tunnels.Kind() != reflect.Slice {
		return 0
	}
	return tunnels.Len()
}

func (d *dialer) rotate() {
	if d == nil || d.controller == nil {
		return
	}
	d.controller.TerminateNextActiveTunnel()
}

func (d *dialer) startTunnelRefresh(ctx context.Context) {
	go func() {
		initial := time.NewTimer(time.Duration(rand.Int63n(int64(tunnelRefreshInterval))))
		defer initial.Stop()
		select {
		case <-ctx.Done():
			return
		case <-initial.C:
		}

		ticker := time.NewTicker(tunnelRefreshInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if d.activeTunnels() < d.targetPool {
					continue
				}
				d.rotate()
			}
		}
	}()
}

// newDialer builds and starts the controller for one region, seeding it with
// the region's server entries.
func newDialer(ctx context.Context, id, region string, entries []ServerEntry) (*dialer, error) {
	dataDir := "/tmp/opendum-psiphon-" + id
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		return nil, err
	}

	serverIDs := make(map[string]struct{}, len(entries))
	for _, entry := range entries {
		serverIDs[entry.ID] = struct{}{}
	}

	targetPool := len(entries)
	if targetPool > MaxTunnelsPerRegion {
		targetPool = MaxTunnelsPerRegion
	}
	if targetPool < 1 {
		targetPool = 1
	}

	config, err := psiphon.LoadConfig(mustJSON(buildConfig(dataDir, targetPool, region)))
	if err != nil {
		return nil, err
	}
	if err := config.Commit(true); err != nil {
		return nil, err
	}
	if err := psiphon.OpenDataStore(config); err != nil {
		return nil, err
	}
	for _, entry := range entries {
		if err := storeServerEntries(ctx, config, entry.Raw); err != nil {
			slog.Warn("psiphon: store server entry", "region", region, "error", err)
		}
	}

	controller, err := psiphon.NewController(config)
	if err != nil {
		return nil, err
	}

	runCtx, cancel := context.WithCancel(context.WithoutCancel(ctx))
	d := &dialer{
		id:         id,
		region:     region,
		controller: controller,
		cancel:     cancel,
		targetPool: targetPool,
		serverIDs:  serverIDs,
	}

	registerDialer(d)
	go controller.Run(runCtx)
	d.startTunnelRefresh(runCtx)
	return d, nil
}

func (d *dialer) close() {
	if d != nil && d.cancel != nil {
		d.cancel()
	}
}

// storeServerEntries streams encoded entries into the open datastore, reusing
// the same decoder Psiphon uses for embedded and remote lists.
func storeServerEntries(ctx context.Context, config *psiphon.Config, raw string) error {
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	decoder := protocol.NewStreamingServerEntryDecoder(
		strings.NewReader(raw),
		common.TruncateTimestampToHour(common.GetCurrentTimestamp()),
		protocol.SERVER_ENTRY_SOURCE_REMOTE,
	)
	return psiphon.StreamingStoreServerEntries(ctx, config, decoder, true)
}

func mustJSON(value any) []byte {
	data, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return data
}

// dialerRegistry maps a server's diagnostic ID back to the dialer that owns
// it, so the notice writer can attribute ActiveTunnel events to a region.
var (
	dialerRegistryMu sync.Mutex
	dialerByServerID = map[string]*dialer{}
)

func registerDialer(d *dialer) {
	dialerRegistryMu.Lock()
	defer dialerRegistryMu.Unlock()
	for id := range d.serverIDs {
		dialerByServerID[id] = d
	}
}

func dialerForDiagnosticID(id string) *dialer {
	dialerRegistryMu.Lock()
	defer dialerRegistryMu.Unlock()
	return dialerByServerID[id]
}
