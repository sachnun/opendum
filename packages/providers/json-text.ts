import { Option, Schema } from "effect";

const JsonRecord = Schema.Record(Schema.String, Schema.Unknown);
const decodeJsonRecord = Schema.decodeUnknownOption(Schema.fromJsonString(JsonRecord));

export class JSONText {
  static record(text: string): Record<string, unknown> | null {
    return Option.getOrNull(decodeJsonRecord(text));
  }

  static sseLines(text: string): Array<Record<string, unknown>> {
    const events: Array<Record<string, unknown>> = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice("data:".length).trim();
      if (!data || data === "[DONE]") continue;
      const parsed = JSONText.record(data);
      if (parsed) events.push(parsed);
    }
    return events;
  }
}
