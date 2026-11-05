import { Metric } from "effect";

export const proxyRequests = Metric.counter("opendum_proxy_requests_total", {
  description: "Total proxy requests handled",
  incremental: true,
});

export const proxyRequestFailures = Metric.counter("opendum_proxy_request_failures_total", {
  description: "Total proxy requests that ended in an error response",
  incremental: true,
});

export const accountRotations = Metric.counter("opendum_proxy_account_rotations_total", {
  description: "Total provider account rotations caused by upstream failures",
  incremental: true,
});

export const upstreamErrors = Metric.counter("opendum_proxy_upstream_errors_total", {
  description: "Total upstream error responses observed",
  incremental: true,
});

export const tokenRefreshes = Metric.counter("opendum_proxy_token_refreshes_total", {
  description: "Total provider token refresh attempts",
  incremental: true,
});

export const tokenRefreshFailures = Metric.counter("opendum_proxy_token_refresh_failures_total", {
  description: "Total provider token refresh failures",
  incremental: true,
});

export const requestDuration = Metric.histogram("opendum_proxy_request_duration_ms", {
  description: "Proxy request duration in milliseconds",
  boundaries: Metric.exponentialBoundaries({ start: 1, factor: 2, count: 16 }),
});

export const upstreamTtft = Metric.histogram("opendum_proxy_upstream_ttft_ms", {
  description: "Upstream time to first response in milliseconds",
  boundaries: Metric.exponentialBoundaries({ start: 1, factor: 2, count: 16 }),
});

export const providerPerformance = Metric.gauge("opendum_proxy_provider_score", {
  description: "Latest provider routing score",
});

export const modelSaturationHolds = Metric.counter("opendum_proxy_model_saturation_holds_total", {
  description: "Total upstream model saturation signals parked behind a shared cooldown",
  incremental: true,
});

export const modelSaturationWaits = Metric.counter("opendum_proxy_model_saturation_waits_total", {
  description: "Total requests that waited on a model saturation cooldown instead of rotating accounts",
  incremental: true,
});
