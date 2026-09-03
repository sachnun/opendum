package providers

import (
	"context"
	"sort"
	"strings"

	"github.com/opendum/opendum/packages/ai/pkg/sync"
	"github.com/opendum/opendum/packages/ai/pkg/sync/cleankey"
)

type Provider struct {
	Name string
	Sync func(ctx context.Context, modelsDir string) (sync.ProviderResult, error)
}

func sanitizeKey(s string) string {
	var b strings.Builder
	for _, r := range s {
		switch {
		case r == ':' || r == '/':
			b.WriteRune('-')
		case r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '.' || r == '_' || r == '-':
			b.WriteRune(r)
		default:
			b.WriteRune('-')
		}
	}
	res := b.String()
	for strings.Contains(res, "--") {
		res = strings.ReplaceAll(res, "--", "-")
	}
	return res
}

func buildSuffixedMap(ids []string, toKey func(string) string) map[string]string {
	m := map[string]string{}
	for _, id := range ids {
		base := toKey(id)
		key := base
		suffix := 2
		for {
			existing, ok := m[key]
			if !ok || existing == id {
				break
			}
			key = base + "-" + itoa(suffix)
			suffix++
		}
		m[key] = id
	}
	return sortMap(m)
}

func sortMap(m map[string]string) map[string]string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	out := make(map[string]string, len(m))
	for _, k := range keys {
		out[k] = m[k]
	}
	return out
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	buf := []byte{}
	for n > 0 {
		buf = append([]byte{byte('0' + n%10)}, buf...)
		n /= 10
	}
	return string(buf)
}

func stripKey(s string) string {
	return cleankey.StripParamInfoKey(s)
}

func trimFreeSuffix(cleaned string) string {
	if strings.HasSuffix(cleaned, "-free") {
		return cleaned[:len(cleaned)-len("-free")]
	}
	return cleaned
}
