import { createId } from "@paralleldrive/cuid2";
import { boolean, index, integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { user } from "./auth.js";
import { providerAccount } from "./accounts.js";
import { proxyApiKey } from "./keys.js";

export const userPointBalance = pgTable("user_point_balance", {
  userId: text("userId")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  balance: integer("balance").notNull().default(15),
  rewardsExcluded: boolean("rewardsExcluded").notNull().default(false),
  rewardsExcludedReason: text("rewardsExcludedReason"),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  updatedAt: timestamp("updatedAt")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const userSharingSetting = pgTable("user_sharing_setting", {
  userId: text("userId")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  enabled: boolean("enabled").notNull().default(false),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  updatedAt: timestamp("updatedAt")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

/**
 * Append-only request log.
 *
 * `id` is deliberately not a primary key: nothing looks rows up by id, and the
 * unique index cost 11 MB plus an index write on every insert. The covering
 * index below serves every dashboard query as an index-only scan.
 */
export const usageLog = pgTable(
  "usage_log",
  {
    id: text("id")
      .notNull()
      .$defaultFn(() => createId()),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    providerAccountId: text("providerAccountId").references(
      () => providerAccount.id,
      { onDelete: "set null" },
    ),
    proxyApiKeyId: text("proxyApiKeyId").references(() => proxyApiKey.id, {
      onDelete: "set null",
    }),

    model: text("model").notNull(),
    inputTokens: integer("inputTokens").notNull().default(0),
    outputTokens: integer("outputTokens").notNull().default(0),
    cachedTokens: integer("cachedTokens").notNull().default(0),
    cacheWriteTokens: integer("cacheWriteTokens").notNull().default(0),

    // Request metadata
    statusCode: integer("statusCode"),
    duration: integer("duration"),

    createdAt: timestamp("createdAt").notNull().defaultNow(),
  },
  (table) => [
    index("usage_log_userId_createdAt_idx").on(
      table.userId,
      table.createdAt,
      table.inputTokens,
      table.outputTokens,
      table.cachedTokens,
      table.cacheWriteTokens,
      table.statusCode,
      table.duration,
      table.providerAccountId,
      table.proxyApiKeyId,
      table.model,
    ),
  ],
);

export const pointTransaction = pgTable(
  "point_transaction",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId()),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    amount: integer("amount").notNull(),
    type: text("type").notNull(),
    balanceAfter: integer("balanceAfter").notNull(),
    idempotencyKey: text("idempotencyKey"),
    // No foreign key: the column is never written and a FK here would force
    // the dropped usage_log primary key index to stay alive.
    usageLogId: text("usageLogId"),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("point_transaction_idempotencyKey_key").on(
      table.idempotencyKey,
    ),
    index("point_transaction_userId_createdAt_idx").on(
      table.userId,
      table.createdAt,
    ),

  ],
);
