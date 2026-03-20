import { formatDistanceToNowStrict } from "date-fns";

export function formatRelativeTime(value: Date | string | number): string {
  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "-";
  }

  const relative = formatDistanceToNowStrict(date, { addSuffix: true });

  return relative === "0 seconds ago" ? "just now" : relative;
}
