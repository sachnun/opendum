package proxy

import (
	"strings"
	"testing"

	appdb "github.com/opendum/opendum/apps/proxy/internal/db"
)

func benchStreamBody(events int) string {
	event := "data: {\"id\":\"chatcmpl-1\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"hello world\"},\"finish_reason\":null}]}\n\n"
	return strings.Repeat(event, events)
}

// benchStreamChunk mimics the 32KiB read buffer the streaming handlers use.
func benchStreamChunk(events int) []byte {
	body := benchStreamBody(events)
	chunk := make([]byte, 0, 32*1024)
	for len(chunk) < 32*1024 {
		chunk = append(chunk, body...)
	}
	return chunk
}

func BenchmarkSSEScannerLargeStream(b *testing.B) {
	chunk := benchStreamChunk(64)
	b.SetBytes(int64(len(chunk)))
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		scanner := &sseScanner{}
		scanner.Process(chunk, func(sseEvent) {})
		scanner.Flush(func(sseEvent) {})
	}
}

func BenchmarkSSEScannerTinyChunks(b *testing.B) {
	body := benchStreamBody(64)
	b.SetBytes(int64(len(body)))
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		scanner := &sseScanner{}
		for offset := 0; offset < len(body); offset += 17 {
			end := offset + 17
			if end > len(body) {
				end = len(body)
			}
			scanner.Process([]byte(body[offset:end]), func(sseEvent) {})
		}
		scanner.Flush(func(sseEvent) {})
	}
}

func BenchmarkSortAccountsByProviderPriority(b *testing.B) {
	priority := []string{"openrouter", "kiro", "codex", "antigravity"}
	accounts := make([]appdb.ProviderAccount, 0, 256)
	for i := 0; i < 256; i++ {
		accounts = append(accounts, appdb.ProviderAccount{
			ID:       "acct",
			Provider: priority[i%len(priority)],
			Status:   "active",
		})
	}
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		work := append([]appdb.ProviderAccount(nil), accounts...)
		sortAccountsByProviderPriority(work, priority)
	}
}
