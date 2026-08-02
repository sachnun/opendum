import { randomBytes, createHash } from "node:crypto";

/** upstream response start recorder (context-based, mirrors latency.go). */
export type ResponseStartRecorder = (at: Date) => void;

export function markUpstreamResponseStarted(ctx: { recordResponseStart?: ResponseStartRecorder }): void {
  if (ctx.recordResponseStart) ctx.recordResponseStart(new Date());
}
