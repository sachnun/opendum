import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { db, providerAccount } from "@opendum/database";
import type { FreebuffSessionBatchData, FreebuffSessionInfo } from "../../lib/api-types";
import { getRedisClient } from "../lib/redis";

const SESSION_KEY_PREFIX = "opendum:freebuff:session:";

export const freebuffSessionBatchInputSchema = z.object({ accountIds: z.array(z.string()).max(200) });

export async function getFreebuffSessions(userId: string, input: { accountIds: string[] }): Promise<FreebuffSessionBatchData> {
  const accountIds = [...new Set(input.accountIds.map((id) => id.trim()).filter(Boolean))];
  if (accountIds.length === 0) return {};

  const rows = await db
    .select({ id: providerAccount.id })
    .from(providerAccount)
    .where(and(eq(providerAccount.userId, userId), eq(providerAccount.provider, "freebuff"), inArray(providerAccount.id, accountIds)));
  const owned = rows.map((row) => row.id);
  if (owned.length === 0) return {};

  try {
    const redis = await getRedisClient();
    const values = await redis.mGet(owned.map((id) => `${SESSION_KEY_PREFIX}${id}`));
    const sessions: FreebuffSessionBatchData = {};
    owned.forEach((id, index) => {
      const raw = values[index];
      if (!raw) return;
      try {
        sessions[id] = JSON.parse(raw) as FreebuffSessionInfo;
      } catch {
        // Ignore malformed snapshot entries.
      }
    });
    return sessions;
  } catch {
    return {};
  }
}
