FROM golang:1.26-bookworm AS builder
WORKDIR /src
COPY apps/proxy/go.mod apps/proxy/go.sum ./apps/proxy/
WORKDIR /src/apps/proxy
RUN go mod download
WORKDIR /src
COPY apps/proxy ./apps/proxy
COPY packages/models/data ./packages/models/data
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go -C apps/proxy build -trimpath -buildvcs=false -ldflags="-s -w -buildid=" -o /app/proxy ./cmd/proxy

FROM gcr.io/distroless/static-debian12:nonroot
WORKDIR /app
COPY --from=builder /app/proxy ./proxy
COPY packages/models/data ./packages/models/data
EXPOSE 8000
CMD ["./proxy"]
