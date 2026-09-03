package providers

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/opendum/opendum/packages/ai/pkg/sync/httpfetch"
)

var (
	antigravityVersionSources = []string{
		"https://releasebot.io/updates/google/antigravity",
		"https://antigravity.google/changelog",
	}
	antigravityVersionRe      = regexp.MustCompile(`\b(\d+\.\d+\.\d+)\b`)
	antigravityProxyAgentRe   = regexp.MustCompile(`((?:const\s+antigravityUserAgent\s*=\s*"antigravity\/))(\d+\.\d+\.\d+)(\s+")`)
	antigravityDashAgentRe    = regexp.MustCompile("((?:export\\s+)?const USER_AGENT\\s*=\\s*`antigravity\\/)(\\d+\\.\\d+\\.\\d+)(\\s+linux/amd64`; )")
	antigravityDashAgentReAlt = regexp.MustCompile("((?:export\\s+)?const USER_AGENT\\s*=\\s*`antigravity\\/)(\\d+\\.\\d+\\.\\d+)(\\s+linux/amd64`;)")
)

func antigravityParseLatest(html string) string {
	versions := []string{}
	for _, m := range antigravityVersionRe.FindAllStringSubmatch(html, -1) {
		v := m[1]
		if strings.HasPrefix(v, "1.") && !strings.HasPrefix(v, "1.0") {
			versions = append(versions, v)
		}
	}
	if len(versions) == 0 {
		return ""
	}
	sort.Slice(versions, func(i, j int) bool { return antigravityCompareSemver(versions[i], versions[j]) > 0 })
	return versions[0]
}

func antigravityCompareSemver(a, b string) int {
	pa := parseSemverParts(a)
	pb := parseSemverParts(b)
	for i := 0; i < 3; i++ {
		if pa[i] != pb[i] {
			if pa[i] > pb[i] {
				return 1
			}
			return -1
		}
	}
	return 0
}

func parseSemverParts(v string) [3]int {
	var out [3]int
	parts := strings.Split(v, ".")
	for i := 0; i < 3 && i < len(parts); i++ {
		n, _ := strconv.Atoi(parts[i])
		out[i] = n
	}
	return out
}

func SyncAntigravityVersion(ctx context.Context, modelsDir string) error {
	root := filepath.Join(modelsDir, "..", "..", "..")
	proxyPath := filepath.Join(root, "apps", "proxy", "internal", "providers", "google_code_assist.go")
	dashPath := filepath.Join(root, "apps", "dashboard", "server", "lib", "providers", "antigravity", "constants.ts")
	proxySrc, err := os.ReadFile(proxyPath)
	if err != nil {
		return err
	}
	m := antigravityProxyAgentRe.FindStringSubmatch(string(proxySrc))
	if m == nil {
		fmt.Printf("Antigravity: could not find User-Agent version in Go proxy provider, skipping.\n")
		return nil
	}
	current := m[2]
	fmt.Printf("Antigravity: current proxy User-Agent version is %s\n", current)
	client := &http.Client{Timeout: 15 * time.Second}
	latest := ""
	for _, src := range antigravityVersionSources {
		html, err := httpfetch.FetchText(ctx, client, src, &httpfetch.Options{Label: src, Timeout: 15 * time.Second, Headers: map[string]string{"Accept": "text/html"}})
		if err != nil {
			fmt.Printf("Antigravity: fetch failed for %s (%v)\n", src, err)
			continue
		}
		if v := antigravityParseLatest(html); v != "" {
			fmt.Printf("Antigravity: latest version from %s is %s\n", src, v)
			latest = v
			break
		}
	}
	if latest == "" {
		fmt.Printf("Antigravity: could not parse version from any source, skipping.\n")
		return nil
	}
	if antigravityCompareSemver(latest, current) > 0 {
		updateVersionInFile(proxyPath, antigravityProxyAgentRe, latest)
		updateVersionInFile(dashPath, antigravityDashAgentRe, latest)
		updateVersionInFile(dashPath, antigravityDashAgentReAlt, latest)
		fmt.Printf("Antigravity: updated User-Agent version %s -> %s\n", current, latest)
	} else {
		fmt.Printf("Antigravity: User-Agent version is already up to date.\n")
	}
	return nil
}

func updateVersionInFile(path string, re *regexp.Regexp, version string) {
	src, err := os.ReadFile(path)
	if err != nil {
		return
	}
	updated := re.ReplaceAllString(string(src), "${1}"+version+"${3}")
	if updated != string(src) {
		_ = os.WriteFile(path, []byte(updated), 0644)
	}
}
