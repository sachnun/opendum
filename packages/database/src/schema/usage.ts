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

export const usageLog = pgTable(
  "usage_log",
  {
    id: text("id")
      .primaryKey()
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

    // Request metadata
    statusCode: integer("statusCode"),
    duration: integer("duration"),

    createdAt: timestamp("createdAt").notNull().defaultNow(),
  },
  (table) => [
    index("usage_log_userId_createdAt_idx").on(
      table.userId,
      table.createdAt,
    ),
    index("usage_log_userId_providerAccountId_createdAt_idx").on(
      table.userId,
      table.providerAccountId,
      table.createdAt,
    ),
    index("usage_log_userId_proxyApiKeyId_createdAt_idx").on(
      table.userId,
      table.proxyApiKeyId,
      table.createdAt,
    ),
    index("usage_log_providerAccountId_idx").on(table.providerAccountId),
    index("usage_log_createdAt_idx").on(table.createdAt),
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
    usageLogId: text("usageLogId").references(() => usageLog.id, {
      onDelete: "set null",
    }),
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
    index("point_transaction_usageLogId_idx").on(table.usageLogId),
  ],
);
