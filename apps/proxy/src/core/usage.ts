import type Redis from "ioredis";
import type { ProxyDB } from "../db/index.js";
import { schema, newIDHelper } from "./db-helpers.js";
import { isSyntheticProviderAccountID } from "./load-balancer-helpers.js";

export interface UsageParams {
  userId: string;
  providerAccountId: string;
  proxyApiKeyId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  statusCode: number;
  durationMS: number;
  provider: string;
}

export async function logUsage(db: ProxyDB | null, redis: Redis | null, bumpFn: ((userId: string) => void) | null, params: UsageParams): Promise<void> {
  if (params.userId === "" || params.model === "") return;
  if (!db) return;
  const now = new Date();
  const providerAccountID = params.providerAccountId !== "" && !isSyntheticProviderAccountID(params.providerAccountId) ? params.providerAccountId : null;
  const proxyApiKeyID = params.proxyApiKeyId !== "" ? params.proxyApiKeyId : null;
  const status = params.statusCode;
  const duration = params.durationMS;
  try {
    await db.insert(schema.usageLog).values({
      id: newIDHelper(),
      userId: params.userId,
      providerAccountId: providerAccountID,
      proxyApiKeyId: proxyApiKeyID,
      model: params.model,
      inputTokens: params.inputTokens,
      outputTokens: params.outputTokens,
      statusCode: status,
      duration,
      createdAt: now,
    });
    if (bumpFn) bumpFn(params.userId);
  } catch {
    // ignore usage logging failures
  }
}

export async function recordLatency(redis: Redis | null, provider: string, model: string, stream: boolean, latencyMS: number): Promise<void> {
  if (latencyMS <= 0 || !redis) return;
  const mode = stream ? "stream" : "nonstream";
  const key = `opendum:latency:${provider}:${model.trim().toLowerCase()}:${mode}`;
  const now = Date.now();
  const member = `${latencyMS}:${now}`;
  try {
    const pipe = redis.pipeline();
    pipe.zadd(key, now, member);
    pipe.zremrangebyrank(key, 0, -101);
    pipe.expire(key, 24 * 3600);
    await pipe.exec();
  } catch {
    // ignore
  }
}
