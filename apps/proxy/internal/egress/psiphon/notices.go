package psiphon

import (
	"encoding/json"
	"log/slog"
	"sync"

	"github.com/Psiphon-Labs/psiphon-tunnel-core/psiphon"
)

var noticesOnce sync.Once

// initNotices installs the process-wide psiphon notice receiver once. It
// attributes each ActiveTunnel notice to the dialer that owns the connected
// server so a region knows when its pool is usable.
func initNotices() {
	noticesOnce.Do(func() {
		psiphon.SetNoticeWriter(psiphon.NewNoticeReceiver(func(notice []byte) {
			var msg struct {
				Type string `json:"noticeType"`
				Data struct {
					DiagnosticID string `json:"diagnosticID"`
				} `json:"data"`
			}
			if json.Unmarshal(notice, &msg) != nil {
				return
			}
			if msg.Type != "ActiveTunnel" {
				return
			}
			d := dialerForDiagnosticID(msg.Data.DiagnosticID)
			if d == nil {
				return
			}
			n := d.tunnelReady.Add(1)
			if n == 1 || int(n) == d.targetPool {
				slog.Info("psiphon: tunnels ready", "region", d.region, "ready", n, "target", d.targetPool)
			}
		}))
	})
}
