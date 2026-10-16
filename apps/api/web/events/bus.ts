import type { LiveTopic, ServerEvent } from "@opendum/providers/contract";
import { EventPublisher } from "@orpc/server";

const POINTS_DEBOUNCE_MS = 1_500;
const HEARTBEAT_MS = 20_000;

const publisher = new EventPublisher<Record<string, ServerEvent>>({ maxBufferedEvents: 32 });

const activeUserIds = new Set<string>();
const pointsBalances = new Map<string, number>();
const pointsTimers = new Map<string, ReturnType<typeof setTimeout>>();

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
  }
}

const heartbeat = setInterval(() => {
  for (const userId of activeUserIds) publishToUser(userId, { type: "ping", at: now() });
}, HEARTBEAT_MS);

heartbeat.unref?.();
