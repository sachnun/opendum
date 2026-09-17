package proxy

import (
	"math"
	"strings"
	"testing"
	"time"

	appdb "github.com/opendum/opendum/apps/proxy/internal/db"
)

func TestParseQuotaNumber(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name   string
		in     any
		want   float64
		wantOK bool
	}{
		{"float", 1.5, 1.5, true},
		{"int", 2, 2, true},
		{"int64", int64(3), 3, true},
		{"numeric string trimmed", " 4.25 ", 4.25, true},
		{"non numeric string", "abc", 0, false},
		{"nil", nil, 0, false},
		{"NaN rejected", math.NaN(), 0, false},
		{"Inf rejected", math.Inf(1), 0, false},
		{"bool rejected", true, 0, false},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got, ok := parseQuotaNumber(tc.in)
			if ok != tc.wantOK || (ok && got != tc.want) {
				t.Fatalf("parseQuotaNumber(%v) = (%v, %v), want (%v, %v)", tc.in, got, ok, tc.want, tc.wantOK)
			}
		})
	}
}

func TestClampFraction(t *testing.T) {
	t.Parallel()
	for input, want := range map[float64]float64{-1: 0, 0: 0, 0.5: 0.5, 1: 1, 2: 1} {
		if got := clampFraction(input); got != want {
			t.Errorf("clampFraction(%v) = %v, want %v", input, got, want)
		}
	}
}

func TestDisplayNumber(t *testing.T) {
	t.Parallel()
	cases := []struct {
		in   float64
		want float64
	}{
		{5, 5},
		{5.0005, 5},
		{1.234, 1.23},
		{1.236, 1.24},
	}
	for _, tc := range cases {
		if got := displayNumber(tc.in); got != tc.want {
			t.Errorf("displayNumber(%v) = %v, want %v", tc.in, got, tc.want)
		}
	}
}

func TestFormatTimeUntilReset(t *testing.T) {
	t.Parallel()
	if got := formatTimeUntilReset(0); got != nil {
		t.Fatalf("formatTimeUntilReset(0) = %v, want nil", *got)
	}
	if got := formatTimeUntilReset(-1); got != nil {
		t.Fatalf("formatTimeUntilReset(-1) = %v, want nil", *got)
	}
	past := time.Now().Add(-time.Minute).UnixMilli()
	if got := formatTimeUntilReset(past); got == nil || *got != "resetting..." {
		t.Fatalf("formatTimeUntilReset(past) = %v, want resetting...", got)
	}

	now := time.Now().UnixMilli()
	cases := []struct {
		name  string
		after time.Duration
		want  string
	}{
		{"minutes", 30*time.Minute + 30*time.Second, "30m"},
		{"hours and minutes", 5*time.Hour + 30*time.Minute + 30*time.Second, "5h 30m"},
		{"whole hours", 2*time.Hour + 30*time.Second, "2h"},
		{"days", 3*24*time.Hour + 30*time.Second, "3d"},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got := formatTimeUntilReset(now + tc.after.Milliseconds())
			if got == nil || *got != tc.want {
				t.Fatalf("formatTimeUntilReset(+%v) = %v, want %q", tc.after, ptrString(got), tc.want)
			}
		})
	}
}

func ptrString(value *string) string {
	if value == nil {
		return "<nil>"
	}
	return *value
}

func TestFormatTimeUntilResetISO(t *testing.T) {
	t.Parallel()
	if got := formatTimeUntilResetISO(nil); got != nil {
		t.Fatalf("nil ISO = %v, want nil", *got)
	}
	blank := "  "
	if got := formatTimeUntilResetISO(&blank); got != nil {
		t.Fatalf("blank ISO = %v, want nil", *got)
	}
	invalid := "not-a-time"
	if got := formatTimeUntilResetISO(&invalid); got != nil {
		t.Fatalf("invalid ISO = %v, want nil", *got)
	}
	future := time.Now().Add(30 * time.Minute).Format(time.RFC3339Nano)
	got := formatTimeUntilResetISO(&future)
	if got == nil || !strings.HasSuffix(*got, "m") {
		t.Fatalf("future ISO = %v, want minutes value", got)
	}
}

func TestQuotaFallbackTier(t *testing.T) {
	t.Parallel()
	if got := quotaFallbackTier(appdb.ProviderAccount{}); got != "free" {
		t.Fatalf("nil tier = %q, want free", got)
	}
	blank := "  "
	if got := quotaFallbackTier(appdb.ProviderAccount{Tier: &blank}); got != "free" {
		t.Fatalf("blank tier = %q, want free", got)
	}
	pro := " pro "
	if got := quotaFallbackTier(appdb.ProviderAccount{Tier: &pro}); got != "pro" {
		t.Fatalf("trimmed tier = %q, want pro", got)
	}
}

func TestQuotaInfoConstructors(t *testing.T) {
	t.Parallel()
	expired := expiredQuotaInfo(appdb.ProviderAccount{}, "Token expired")
	if expired.Status != "expired" || expired.Error != "Token expired" || expired.Groups == nil || len(expired.Groups) != 0 {
		t.Fatalf("expiredQuotaInfo = %+v", expired)
	}
	failed := errorQuotaInfo(appdb.ProviderAccount{}, "boom", 123)
	if failed.Status != "error" || failed.Error != "boom" || len(failed.Groups) != 0 {
		t.Fatalf("errorQuotaInfo = %+v", failed)
	}
}

func TestReadQuotaLimit(t *testing.T) {
	t.Parallel()
	if got := readQuotaLimit(nil, 10); got != "" {
		t.Fatalf("nil reader = %q, want empty", got)
	}
	if got := readQuotaLimit(strings.NewReader("0123456789"), 4); got != "0123" {
		t.Fatalf("limit = %q, want 0123", got)
	}
	if got := readQuotaLimit(strings.NewReader("abc"), 100); got != "abc" {
		t.Fatalf("under limit = %q, want abc", got)
	}
}

func TestEncodeQuotaBody(t *testing.T) {
	t.Parallel()
	if got, err := encodeQuotaBody(nil); err != nil || got != nil {
		t.Fatalf("nil body = (%v, %v), want (nil, nil)", got, err)
	}
	got, err := encodeQuotaBody(map[string]any{"a": 1})
	if err != nil {
		t.Fatalf("encodeQuotaBody: %v", err)
	}
	if string(got) != `{"a":1}` {
		t.Fatalf("encoded = %q, want {\"a\":1}", got)
	}
}

func TestEncodeQuery(t *testing.T) {
	t.Parallel()
	if got := encodeQuery("https://api.example.com/v1", nil); got != "https://api.example.com/v1" {
		t.Fatalf("no values = %q", got)
	}
	got := encodeQuery("https://api.example.com/v1", map[string][]string{"b": {"2"}, "a": {"1"}})
	if got != "https://api.example.com/v1?a=1&b=2" {
		t.Fatalf("encoded = %q, want sorted query", got)
	}
}

func TestParseQuotaHelpers(t *testing.T) {
	t.Parallel()
	if got := parseQuotaString("  hi "); got != "hi" {
		t.Fatalf("parseQuotaString = %q, want hi", got)
	}
	if got := parseQuotaString(42); got != "" {
		t.Fatalf("parseQuotaString(non-string) = %q, want empty", got)
	}
	if record := parseQuotaRecord(map[string]any{"a": 1}); record == nil || record["a"] != 1 {
		t.Fatalf("parseQuotaRecord = %v", record)
	}
	if record := parseQuotaRecord("x"); record != nil {
		t.Fatalf("parseQuotaRecord(non-map) = %v, want nil", record)
	}
	if array := parseQuotaArray([]any{1, 2}); len(array) != 2 {
		t.Fatalf("parseQuotaArray = %v", array)
	}
	if array := parseQuotaArray("x"); array != nil {
		t.Fatalf("parseQuotaArray(non-array) = %v, want nil", array)
	}
}
