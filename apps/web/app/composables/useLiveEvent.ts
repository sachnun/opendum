import type { LiveTopic } from "@opendum/providers/contract";

export function liveEventVersionKey(topic: LiveTopic): string {
  return `web-live-${topic}-version`;
}

export function useLiveEvent(topic: LiveTopic, handler: () => void): void {
  const version = useState<number>(liveEventVersionKey(topic), () => 0);

  watch(version, () => handler());
}
