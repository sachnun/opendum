package providers

import (
	"context"
	"time"
)

type upstreamResponseStartRecorderKey struct{}

func WithUpstreamResponseStartRecorder(ctx context.Context, record func(time.Time)) context.Context {
	if record == nil {
		return ctx
	}
	return context.WithValue(ctx, upstreamResponseStartRecorderKey{}, record)
}

func MarkUpstreamResponseStarted(ctx context.Context) {
	record, _ := ctx.Value(upstreamResponseStartRecorderKey{}).(func(time.Time))
	if record != nil {
		record(time.Now())
	}
}
