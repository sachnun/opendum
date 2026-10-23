import type { AccountsData, LiveTopic, ModelsData, ServerEvent, UsageData } from "@opendum/providers/contract";
import { EventPublisher } from "@orpc/server";
import { Effect, Match } from "effect";

import { proxyEvents } from "../../core/events.js";
import { trackWork } from "../../core/pending.js";

const POINTS_DEBOUNCE_MS = 1_500;
const SNAPSHOT_DEBOUNCE_MS = 400;
const USAGE_THROTTLE_MS = 10_000;
const HEARTBEAT_MS = 20_000;

export interface EventSnapshots {
  accounts: AccountsData;
  models: ModelsData;
  usage: UsageData;
}

export type SnapshotBuilder = (userId: string, topics: LiveTopic[]) => Promise<Partial<EventSnapshots>>;

const publisher = new EventPublisher<Record<string, ServerEvent>>({ maxBufferedEvents: 32 });

const activeUserIds = new Set<string>();
const pointsBalances = new Map<string, number>();
const pointsTimers = new Map<string, ReturnType<typeof setTimeout>>();
const snapshotTimers = new Map<string, ReturnType<typeof setTimeout>>();
const usagePublishedAt = new Map<string, number>();
const usagePendingUserIds = new Set<string>();
const usageTimers = new Map<string, ReturnType<typeof setTimeout>>();

let buildSnapshots: SnapshotBuilder = async () => ({});

export function configureEventSnapshots(builder: SnapshotBuilder): void {
  buildSnapshots = builder;
}

function now(): string {
  return new Date().toISOString();
}

export function publishToUser(userId: string, event: ServerEvent): void {
  publisher.publish(userId, event);
}

function toUpdateEvent(topic: LiveTopic, snapshots: Partial<EventSnapshots>): ServerEvent | null {
  return Match.value(topic).pipe(
    Match.when("accounts", () => (snapshots.accounts ? { type: "update" as const, topic: "accounts" as const, at: now(), data: snapshots.accounts } : null)),
    Match.when("models", () => (snapshots.models ? { type: "update" as const, topic: "models" as const, at: now(), data: snapshots.models } : null)),
    Match.when("usage", () => (snapshots.usage ? { type: "update" as const, topic: "usage" as const, at: now(), data: snapshots.usage } : null)),
    Match.orElse(() => null),
  );
}

function publishTopic(userId: string, topic: LiveTopic): void {
  if (!activeUserIds.has(userId)) return;

  trackWork(
    Effect.tryPromise(() => buildSnapshots(userId, [topic])).pipe(
      Effect.map((snapshots) => toUpdateEvent(topic, snapshots)),
      Effect.tap((event) => Effect.sync(() => {
        if (event) publishToUser(userId, event);
      })),
      Effect.catch((cause) => Effect.logError(`Failed to publish ${topic} event for ${userId}`, cause)),
    )
  );
}

export function publishModelsChanged(userId: string): void {
  scheduleTopic(userId, "models");
}

export function publishAccountsChanged(userId: string): void {
  scheduleTopic(userId, "accounts");
}

function scheduleTopic(userId: string, topic: LiveTopic): void {
  if (!activeUserIds.has(userId)) return;

  const key = `${userId}:${topic}`;
  if (snapshotTimers.has(key)) return;

  const timer = setTimeout(() => {
    snapshotTimers.delete(key);
    publishTopic(userId, topic);
  }, SNAPSHOT_DEBOUNCE_MS);

  timer.unref?.();
  snapshotTimers.set(key, timer);
}

function flushUsageChanged(userId: string): void {
  usageTimers.delete(userId);
  usagePendingUserIds.delete(userId);
  usagePublishedAt.set(userId, Date.now());
  publishTopic(userId, "usage");
}

export function publishUsageChanged(userId: string): void {
  if (!activeUserIds.has(userId)) return;

  const elapsed = Date.now() - (usagePublishedAt.get(userId) ?? 0);
  if (elapsed >= USAGE_THROTTLE_MS) {
    flushUsageChanged(userId);
    return;
  }

  usagePendingUserIds.add(userId);
  if (usageTimers.has(userId)) return;

  const timer = setTimeout(() => {
    usageTimers.delete(userId);
    if (!usagePendingUserIds.has(userId)) return;
    flushUsageChanged(userId);
  }, USAGE_THROTTLE_MS - elapsed);

  timer.unref?.();
  usageTimers.set(userId, timer);
}

export function publishPointsBalance(userId: string, balance: number): void {
  pointsBalances.set(userId, balance);
  if (pointsTimers.has(userId)) return;

  const timer = setTimeout(() => {
    pointsTimers.delete(userId);
    const latest = pointsBalances.get(userId);
    pointsBalances.delete(userId);
    if (latest === undefined) return;
    publishToUser(userId, { type: "update", topic: "points", at: now(), data: { balance: latest } });
  }, POINTS_DEBOUNCE_MS);

  timer.unref?.();
  pointsTimers.set(userId, timer);
}

async function* initialEvents(userId: string, topics: LiveTopic[]): AsyncGenerator<ServerEvent, void> {
  const snapshots = await buildSnapshots(userId, topics);
  for (const topic of topics) {
    const event = toUpdateEvent(topic, snapshots);
    if (event) yield event;
  }
}

export async function* subscribeUserEvents(userId: string, topics: LiveTopic[], signal?: AbortSignal): AsyncGenerator<ServerEvent, void> {
  const wanted = new Set<LiveTopic>(topics);
  activeUserIds.add(userId);

  try {
    yield* initialEvents(userId, topics);

    for await (const event of publisher.subscribe(userId, { signal })) {
      if (event.type === "ping" || wanted.has(event.topic)) yield event;
    }
  } finally {
    activeUserIds.delete(userId);
    usagePublishedAt.delete(userId);
    usagePendingUserIds.delete(userId);
    const timer = usageTimers.get(userId);
    if (timer) {
      clearTimeout(timer);
      usageTimers.delete(userId);
    }
    for (const topic of ["accounts", "models"] as const) {
      const key = `${userId}:${topic}`;
      const snapshotTimer = snapshotTimers.get(key);
      if (!snapshotTimer) continue;
      clearTimeout(snapshotTimer);
      snapshotTimers.delete(key);
    }
  }
}

proxyEvents.onUsageLogged((userId) => publishUsageChanged(userId));

const heartbeat = setInterval(() => {
  for (const userId of activeUserIds) publishToUser(userId, { type: "ping", at: now() });
}, HEARTBEAT_MS);

heartbeat.unref?.();
