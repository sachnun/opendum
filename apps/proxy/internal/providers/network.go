package providers

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"strings"
	"syscall"
)

const maxRedirectHops = 10

func privateIP(ip net.IP) bool {
	if ip == nil {
		return true
	}
	addr, ok := netip.AddrFromSlice(ip)
	if !ok {
		return true
	}
	addr = addr.Unmap()
	if addr.IsLoopback() || addr.IsPrivate() || addr.IsLinkLocalUnicast() || addr.IsLinkLocalMulticast() || addr.IsUnspecified() || addr.IsMulticast() {
		return true
	}
	if addr.Is4() {
		octets := addr.As4()
		if octets[0] == 100 && octets[1] >= 64 && octets[1] <= 127 {
			return true
		}
		if octets[0] == 0 {
			return true
		}
	}
	return false
}

// PrivateHost reports whether a hostname is an obvious private target:
// localhost suffixes, or an IP literal in a private/loopback/link-local/
// multicast range (including cloud metadata 169.254.0.0/16 and CGNAT).
func PrivateHost(host string) bool {
	host = strings.ToLower(strings.TrimSpace(host))
	if host == "localhost" || strings.HasSuffix(host, ".localhost") || strings.HasSuffix(host, ".local") || strings.HasSuffix(host, ".internal") {
		return true
	}
	addr, err := netip.ParseAddr(strings.Trim(host, "[]"))
	if err != nil {
		return false
	}
	return privateIP(net.IP(addr.Unmap().AsSlice()))
}

// GuardedDialContext rejects outbound connections whose resolved IPs are
// private, loopback, link-local, or multicast. Because every TCP connection
// goes through this hook, it covers literal hosts, DNS rebinding, and
// redirects in one place instead of only validating the initial URL.
func GuardedDialContext() func(ctx context.Context, network, address string) (net.Conn, error) {
	dialer := &net.Dialer{Control: guardDialControl}
	return dialer.DialContext
}

func guardDialControl(_, address string, _ syscall.RawConn) error {
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return err
	}
	addr, err := netip.ParseAddr(host)
	if err != nil {
		return fmt.Errorf("refusing to dial unresolved address %q", host)
	}
	if privateIP(net.IP(addr.Unmap().AsSlice())) {
		return fmt.Errorf("refusing to connect to private address %s", host)
	}
	return nil
}

// GuardedRedirectPolicy rejects redirect hops to private targets and https
// downgrades so a hostile upstream cannot bounce the proxy to internal
// networks or metadata endpoints.
func GuardedRedirectPolicy() func(req *http.Request, via []*http.Request) error {
	return func(req *http.Request, via []*http.Request) error {
		if len(via) >= maxRedirectHops {
			return errors.New("stopped after 10 redirects")
		}
		target := req.URL
		if target.Scheme != "https" {
			return errors.New("redirect must use https")
		}
		if PrivateHost(target.Hostname()) {
			return errors.New("redirect must not target a private address")
		}
		return nil
	}
}
