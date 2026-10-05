import { isDateToken } from "#models/model/clean-key.ts";

function trailingDateToken(modelId: string): string | null {
  const segment = modelId.slice(modelId.lastIndexOf("/") + 1);
  const tokens = segment.split(/[-_]/);
  const tail = (tokens[tokens.length - 1] ?? "").split(":")[0] ?? "";
  return isDateToken(tail) ? tail : null;
}

function compareCandidatesNewestFirst(left: { dateToken: string | null }, right: { dateToken: string | null }): number {
  if (left.dateToken === null && right.dateToken === null) return 0;
  if (left.dateToken === null) return -1;
  if (right.dateToken === null) return 1;
  return Number.parseInt(right.dateToken, 10) - Number.parseInt(left.dateToken, 10);
}

export function buildModelIdMap(modelIds: string[], toModelKey: (modelId: string) => string): Map<string, string> {
  const groups = new Map<string, Array<{ modelId: string; key: string; dateToken: string | null }>>();

  for (const modelId of modelIds) {
    const key = toModelKey(modelId);
    if (!key) continue;

    const dateToken = trailingDateToken(modelId);
    const baseKey =
      dateToken && key.endsWith(`-${dateToken}`)
        ? key.slice(0, key.length - dateToken.length - 1)
        : key;

    const group = groups.get(baseKey);
    if (group) group.push({ modelId, key, dateToken });
    else groups.set(baseKey, [{ modelId, key, dateToken }]);
  }

  const map = new Map<string, string>();
  for (const [baseKey, candidates] of groups) {
    candidates.sort(compareCandidatesNewestFirst);

    const [winner, ...losers] = candidates;
    if (winner === undefined) continue;
    map.set(baseKey, winner.modelId);

    for (const loser of losers) {
      const stem = loser.dateToken ? `${baseKey}-${loser.dateToken}` : loser.key;
      let key = stem;
      let suffix = 2;
      while (map.has(key) && map.get(key) !== loser.modelId) {
        key = `${stem}-${suffix}`;
        suffix += 1;
      }
      map.set(key, loser.modelId);
    }
  }

  return new Map([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));
}
