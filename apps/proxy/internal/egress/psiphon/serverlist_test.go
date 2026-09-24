package psiphon

import (
	"testing"
)

func TestParseEntriesByRegion(t *testing.T) {
	byRegion := parseEntriesByRegion(embeddedServerEntries)
	if len(byRegion) == 0 {
		t.Fatal("no regions parsed from embedded server entries")
	}
	total := 0
	for region, entries := range byRegion {
		total += len(entries)
		if region == "" {
			t.Fatal("entry parsed with empty region")
		}
		if region != upper(region) {
			t.Fatalf("region %q is not upper-cased", region)
		}
		for _, entry := range entries {
			if entry.ID == "" || entry.IP == "" || entry.Raw == "" {
				t.Fatalf("incomplete entry: %#v", entry)
			}
		}
	}
	if total != 431 {
		t.Fatalf("parsed %d entries, want 431", total)
	}
	if _, ok := byRegion["US"]; !ok {
		t.Fatal("US region missing from embedded server entries")
	}
}

func TestDecodeEntryRejectsInvalid(t *testing.T) {
	for _, line := range []string{"", "not-hex", "00ff"} {
		if _, _, _, ok := decodeEntry(line); ok {
			t.Fatalf("decodeEntry(%q) = ok, want false", line)
		}
	}
}

func TestBuildConfigPinsRegion(t *testing.T) {
	config := buildConfig("/tmp/x", 3, "US")
	if config["EgressRegion"] != "US" {
		t.Fatalf("EgressRegion = %v, want US", config["EgressRegion"])
	}
	if config["TunnelPoolSize"] != 3 {
		t.Fatalf("TunnelPoolSize = %v, want 3", config["TunnelPoolSize"])
	}
	if config["ServerEntrySignaturePublicKey"] != serverEntrySignaturePublicKey {
		t.Fatal("ServerEntrySignaturePublicKey not set")
	}
	empty := buildConfig("/tmp/x", 1, "")
	if _, ok := empty["EgressRegion"]; ok {
		t.Fatal("empty region should omit EgressRegion")
	}
}

func upper(value string) string {
	out := []byte(value)
	for i, c := range out {
		if c >= 'a' && c <= 'z' {
			out[i] = c - ('a' - 'A')
		}
	}
	return string(out)
}
