import type { AccountsData, LiveTopic, ModelsData, UsageData } from "@opendum/providers/contract";

export interface LiveTopicPayloads {
  points: { balance: number };
  accounts: AccountsData;
  models: ModelsData;
  usage: UsageData;
}

export type LiveTopicPayload<Topic extends LiveTopic> = LiveTopicPayloads[Topic];

export function liveEventKey(topic: LiveTopic): string {
  return `web-live-${topic}`;
}

export function useLiveTopic<Topic extends LiveTopic>(topic: Topic) {
  return useState<LiveTopicPayload<Topic> | null>(liveEventKey(topic), () => null);
}

export function useLiveEvent<Topic extends LiveTopic>(topic: Topic, handler: (data: LiveTopicPayload<Topic>) => void): void {
  const payload = useLiveTopic(topic);

  watch(payload, (value) => {
    if (value) handler(value);
  }, { immediate: true });
}
