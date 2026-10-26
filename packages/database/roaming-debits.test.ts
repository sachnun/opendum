import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { drizzle } from "drizzle-orm/bun-sql";

import { listOrphaned } from "@opendum/database/queries/usage-points";
import type { DbExecutor } from "@opendum/database/client";

function captureSql(): { database: DbExecutor; statements: Array<{ sql: string; params: unknown[] }> } {
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const db = drizzle({
    client: {
      options: {},
      unsafe: (query: string, params: unknown[]) => {
        statements.push({ sql: query, params });
        return { values: async () => [] };
      },
    } as never,
  });
  return { database: db as unknown as DbExecutor, statements };
}

describe("listOrphaned", () => {
  it("treats every terminal marker as evidence the reservation closed", async () => {
    const { database, statements } = captureSql();

    await Effect.runPromise(listOrphaned({ olderThan: new Date(0), limit: 10 }, database));

    expect(statements).toHaveLength(1);
    const statement = statements[0]?.sql ?? "";
    expect(statement).toContain("roaming_refund:");
    expect(statement).toContain("roaming_settle:");
    expect(statement).toContain("sharing_credit:");
    expect(statement).toContain("not exists");
  });

  it("filters by debit type and the grace cutoff", async () => {
    const { database, statements } = captureSql();

    await Effect.runPromise(
      listOrphaned({ olderThan: new Date("2025-01-01T00:00:00.000Z"), limit: 5 }, database)
    );

    expect(statements[0]?.params[0]).toBe("roaming_debit");
    expect(statements[0]?.params[1]).toBe("2025-01-01T00:00:00.000Z");
    expect(statements[0]?.params[2]).toBe(5);
  });

  it("returns the mapped rows", async () => {
    const createdAt = new Date(0);

    const rows = await Effect.runPromise(
      listOrphaned(
        { olderThan: createdAt, limit: 1 },
        {
          select: () => ({
            from: () => ({
              where: () => ({
                orderBy: () => ({
                  limit: async () => [{ id: "d1", userId: "u1", amount: -2, createdAt }],
                }),
              }),
            }),
          }),
        } as unknown as DbExecutor
      )
    );

    expect(rows).toEqual([{ id: "d1", userId: "u1", amount: -2, createdAt }]);
  });
});
