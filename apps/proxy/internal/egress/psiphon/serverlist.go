package psiphon

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/Psiphon-Labs/psiphon-tunnel-core/psiphon/common"
	"github.com/Psiphon-Labs/psiphon-tunnel-core/psiphon/common/protocol"
)

const (
	remoteServerListURL = "https://s3.amazonaws.com/psiphon/web/mjr4-p23r-puwl/server_list_compressed"

	// remoteServerListSignaturePublicKey authenticates the compressed remote
	// server list; serverEntrySignaturePublicKey authenticates individual
	// server entries stored into the datastore.
	remoteServerListSignaturePublicKey = "MIICIDANBgkqhkiG9w0BAQEFAAOCAg0AMIICCAKCAgEAt7Ls+/39r+T6zNW7GiVpJfzq/xvL9SBH5rIFnk0RXYEYavax3WS6HOD35eTAqn8AniOwiH+DOkvgSKF2caqk/y1dfq47Pdymtwzp9ikpB1C5OfAysXzBiwVJlCdajBKvBZDerV1cMvRzCKvKwRmvDmHgphQQ7WfXIGbRbmmk6opMBh3roE42KcotLFtqp0RRwLtcBRNtCdsrVsjiI1Lqz/lH+T61sGjSjQ3CHMuZYSQJZo/KrvzgQXpkaCTdbObxHqb6/+i1qaVOfEsvjoiyzTxJADvSytVtcTjijhPEV6XskJVHE1Zgl+7rATr/pDQkw6DPCNBS1+Y6fy7GstZALQXwEDN/qhQI9kWkHijT8ns+i1vGg00Mk/6J75arLhqcodWsdeG/M/moWgqQAnlZAGVtJI1OgeF5fsPpXu4kctOfuZlGjVZXQNW34aOzm8r8S0eVZitPlbhcPiR4gT/aSMz/wd8lZlzZYsje/Jr8u/YtlwjjreZrGRmG8KMOzukV3lLmMppXFMvl4bxv6YFEmIuTsOhbLTwFgh7KYNjodLj/LsqRVfwz31PgWQFTEPICV7GCvgVlPRxnofqKSjgTWI4mxDhBpVcATvaoBl1L/6WLbFvBsoAUBItWwctO2xalKxF5szhGm8lccoc5MZr8kfE0uxMgsxz4er68iCID+rsCAQM="
	serverEntrySignaturePublicKey      = "sHuUVTWaRyh5pZwy4UguSgkwmBe0EHtJJkoF5WrxmvA="

	serverEntryCacheFile = "/tmp/opendum-psiphon/server_entries.txt"
)

// ServerEntry is one decoded Psiphon server entry, tagged with the region it
// egresses from and the raw encoded line used to store it.
type ServerEntry struct {
	ID     string
	IP     string
	Region string
	Raw    string
}

func decodeEntry(line string) (id, ip, region string, ok bool) {
	decoded, err := hex.DecodeString(line)
	if err != nil {
		return "", "", "", false
	}
	decodedLine := string(decoded)
	jsonStart := strings.Index(decodedLine, "{")
	if jsonStart < 0 {
		return "", "", "", false
	}
	var entry struct {
		IPAddress       string `json:"ipAddress"`
		WebServerSecret string `json:"webServerSecret"`
		Tag             string `json:"tag"`
		Region          string `json:"region"`
	}
	if json.Unmarshal([]byte(decodedLine[jsonStart:]), &entry) != nil {
		return "", "", "", false
	}
	if entry.IPAddress == "" {
		return "", "", "", false
	}
	tag := entry.Tag
	if tag == "" {
		tag = protocol.GenerateServerEntryTag(entry.IPAddress, entry.WebServerSecret)
	}
	return protocol.TagToDiagnosticID(tag), entry.IPAddress, entry.Region, true
}

func parseEntriesByRegion(raw string) map[string][]ServerEntry {
	byRegion := make(map[string][]ServerEntry)
	for _, line := range strings.Split(raw, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		id, ip, region, ok := decodeEntry(line)
		if !ok || region == "" {
			continue
		}
		region = strings.ToUpper(region)
		byRegion[region] = append(byRegion[region], ServerEntry{ID: id, IP: ip, Region: region, Raw: line})
	}
	return byRegion
}

// loadServerEntries returns the freshest server entry list available: the
// authenticated remote list, then the last cached copy, then the embedded
// seed. The remote list is what keeps the pool dialable as Psiphon rotates
// its servers.
func loadServerEntries(ctx context.Context, embedded string) string {
	if data, err := fetchRemoteServerList(ctx); err == nil && strings.TrimSpace(data) != "" {
		slog.Info("psiphon: fetched remote server list", "entries", countEntries(data))
		if err := os.MkdirAll(filepath.Dir(serverEntryCacheFile), 0o755); err == nil {
			_ = os.WriteFile(serverEntryCacheFile, []byte(data), 0o644)
		}
		return data
	} else if err != nil {
		slog.Warn("psiphon: remote server list fetch failed", "error", err)
	}
	if cached, err := os.ReadFile(serverEntryCacheFile); err == nil && strings.TrimSpace(string(cached)) != "" {
		slog.Info("psiphon: using cached server entries")
		return string(cached)
	}
	if strings.TrimSpace(embedded) != "" {
		slog.Info("psiphon: using embedded server entries")
		return embedded
	}
	return ""
}

func fetchRemoteServerList(ctx context.Context) (string, error) {
	reqCtx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, remoteServerListURL, nil)
	if err != nil {
		return "", err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
	if err != nil {
		return "", err
	}
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("remote server list: %s", resp.Status)
	}
	data, err := common.ReadAuthenticatedDataPackage(body, true, remoteServerListSignaturePublicKey)
	if err != nil {
		return "", err
	}
	return data, nil
}

func countEntries(data string) int {
	n := 0
	for _, line := range strings.Split(data, "\n") {
		if strings.TrimSpace(line) != "" {
			n++
		}
	}
	return n
}
