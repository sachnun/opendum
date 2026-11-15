import type { AccountsData, LiveTopic, ModelsData, UsageData } from "@opendum/providers/contract";
import { createEffect, createSignal, on, type Accessor } from "solid-js";

export interface LiveTopicPayloads {
  points: { balance: number };
  accounts: AccountsData;
  models: ModelsData;
  usage: UsageData;
}

export type LiveTopicPayload<Topic extends LiveTopic> = LiveTopicPayloads[Topic];

type SignalEntry = [Accessor<unknown>, (next: unknown) => void];

const store = new Map<string, SignalEntry>();

export function liveEventKey(topic: LiveTopic): string {
  return `web-live-${topic}`;
}

function entryFor(topic: LiveTopic, initial: unknown): SignalEntry {
  const key = liveEventKey(topic);
  const existing = store.get(key);
  if (existing) return existing;

  const [read, write] = createSignal(initial);
  const entry: SignalEntry = [read, (next) => write(() => next)];
  store.set(key, entry);
  return entry;
}

export function liveTopic<Topic extends LiveTopic>(topic: Topic): Accessor<LiveTopicPayload<Topic> | null> {
  return entryFor(topic, null)[0] as Accessor<LiveTopicPayload<Topic> | null>;
}

export function setLiveTopic<Topic extends LiveTopic>(topic: Topic, value: LiveTopicPayload<Topic>): void {
  entryFor(topic, null)[1](value);
}

export function resetLiveEvents(): void {
  store.clear();
}

export function useLiveEvent<Topic extends LiveTopic>(
  topic: Topic,
  handler: (data: LiveTopicPayload<Topic>) => void
): void {
  const payload = liveTopic(topic);
  createEffect(
    on(
      payload,
      (value) => {
        if (value) handler(value);
      },
      { defer: false }
    )
  );
}
