import type { LiveTopic, ServerEvent } from "@opendum/providers/contract";
import { EventPublisher } from "@orpc/server";

import { proxyEvents } from "../../core/events.js";

const POINTS_DEBOUNCE_MS = 1_500;
const USAGE_THROTTLE_MS = 10_000;
const HEARTBEAT_MS = 20_000;

const publisher = new EventPublisher<Record<string, ServerEvent>>({ maxBufferedEvents: 32 });

const activeUserIds = new Set<string>();
const pointsBalances = new Map<string, number>();
const pointsTimers = new Map<string, ReturnType<typeof setTimeout>>();
const usagePublishedAt = new Map<string, number>();
const usagePendingUserIds = new Set<string>();
const usageTimers = new Map<string, ReturnType<typeof setTimeout>>();

function now(): string {
  return new Date().toISOString();
}

export function publishToUser(userId: string, event: ServerEvent): void {
  publisher.publish(userId, event);
}

export function publishModelsChanged(userId: string): void {
  publishToUser(userId, { type: "tick", topic: "models", at: now() });
}

export function publishAccountsChanged(userId: string): void {
  publishToUser(userId, { type: "tick", topic: "accounts", at: now() });
}

function flushUsageChanged(userId: string): void {
  usageTimers.delete(userId);
  usagePendingUserIds.delete(userId);
  usagePublishedAt.set(userId, Date.now());
  if (!activeUserIds.has(userId)) return;
  publishToUser(userId, { type: "tick", topic: "usage", at: now() });
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

export async function* subscribeUserEvents(userId: string, topics: LiveTopic[], signal?: AbortSignal): AsyncGenerator<ServerEvent, void> {
  const wanted = new Set<LiveTopic>(topics);
  activeUserIds.add(userId);

  try {
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
  }
}

proxyEvents.onUsageLogged((userId) => publishUsageChanged(userId));

const heartbeat = setInterval(() => {
  for (const userId of activeUserIds) publishToUser(userId, { type: "ping", at: now() });
}, HEARTBEAT_MS);

heartbeat.unref?.();
