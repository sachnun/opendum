package proxy

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

type errorAfterReader struct {
	data []byte
	err  error
}

func (r *errorAfterReader) Read(p []byte) (int, error) {
	if len(r.data) > 0 {
		n := copy(p, r.data)
		r.data = r.data[n:]
		return n, nil
	}
	return 0, r.err
}

func TestPassthroughStreamReturnsReadError(t *testing.T) {
	want := errors.New("upstream broke")
	response := &http.Response{Body: io.NopCloser(&errorAfterReader{data: []byte("data: {\"choices\":[{\"delta\":{\"content\":\"hi\"},\"finish_reason\":null}]}\n\n"), err: want})}
	ctx := responseContext{Response: response, Writer: httptest.NewRecorder(), AccountID: "acct_1", Provider: "test", Model: "m", StartMS: time.Now().UnixMilli()}
	if err := (&Service{}).passthroughStream(ctx); !errors.Is(err, want) {
		t.Fatalf("passthroughStream error = %v, want %v", err, want)
	}
}

func TestPassthroughStreamReturnsRequestContextError(t *testing.T) {
	reqCtx, cancel := context.WithCancel(context.Background())
	cancel()
	request := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil).WithContext(reqCtx)
	response := &http.Response{Body: io.NopCloser(&errorAfterReader{err: errors.New("read after cancel")})}
	ctx := responseContext{Response: response, Request: request, Writer: httptest.NewRecorder(), AccountID: "acct_1", Provider: "test", Model: "m", StartMS: time.Now().UnixMilli()}
	if err := (&Service{}).passthroughStream(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("passthroughStream error = %v, want context.Canceled", err)
	}
}

func TestAnthropicStreamReturnsReadError(t *testing.T) {
	want := errors.New("upstream broke")
	response := &http.Response{Body: io.NopCloser(&errorAfterReader{data: []byte("data: {\"choices\":[{\"delta\":{\"content\":\"hi\"},\"finish_reason\":null}]}\n\n"), err: want})}
	ctx := responseContext{Response: response, Writer: httptest.NewRecorder(), AccountID: "acct_1", Provider: "test", Model: "m", StartMS: time.Now().UnixMilli()}
	if err := (&Service{}).anthropicStream(ctx); !errors.Is(err, want) {
		t.Fatalf("anthropicStream error = %v, want %v", err, want)
	}
}
