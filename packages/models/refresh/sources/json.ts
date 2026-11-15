import { Result } from "effect";

export function parseJson(raw: string): unknown {
  const parsed = Result.try({ try: () => JSON.parse(raw), catch: () => null });
  return Result.isSuccess(parsed) ? parsed.success : null;
}
