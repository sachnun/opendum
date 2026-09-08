import { createId } from "@paralleldrive/cuid2";
import { boolean, index, integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { user } from "./auth.js";

export const providerAccount = pgTable(
  "provider_account",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId()),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    name: text("name").notNull(),
    accessToken: text("accessToken").notNull(),
    refreshToken: text("refreshToken").notNull(),
    expiresAt: timestamp("expiresAt").notNull(),
    apiKey: text("apiKey"),
    projectId: text("projectId"),
    tier: text("tier"),
    accountId: text("accountId"),
    email: text("email"),
    isActive: boolean("isActive").notNull().default(true),
    disabledUntil: timestamp("disabledUntil"),
    lastUsedAt: timestamp("lastUsedAt"),
    requestCount: integer("requestCount").notNull().default(0),
    errorCount: integer("errorCount").notNull().default(0),
    consecutiveErrors: integer("consecutiveErrors").notNull().default(0),
    lastErrorAt: timestamp("lastErrorAt"),
    lastErrorCode: integer("lastErrorCode"),
    lastRecoveredByRotationAt: timestamp("lastRecoveredByRotationAt"),
    status: text("status").notNull().default("active"),
    statusChangedAt: timestamp("statusChangedAt"),
    successCount: integer("successCount").notNull().default(0),
    lastSuccessAt: timestamp("lastSuccessAt"),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow(),
  },
  (table) => [
    index("provider_account_userId_idx").on(table.userId),
    index("provider_account_provider_idx").on(table.provider),
  ]
);

export const providerAccountModelHealth = pgTable(
  "provider_account_model_health",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId()),
    providerAccountId: text("providerAccountId")
      .notNull()
      .references(() => providerAccount.id, { onDelete: "cascade" }),
    model: text("model").notNull(),
    consecutiveErrors: integer("consecutiveErrors").notNull().default(0),
    status: text("status").notNull().default("active"),
    statusChangedAt: timestamp("statusChangedAt"),
    lastErrorAt: timestamp("lastErrorAt"),
    lastErrorCode: integer("lastErrorCode"),
    lastSuccessAt: timestamp("lastSuccessAt"),
    unhealthyCountUpdatedAt: timestamp("unhealthyCountUpdatedAt"),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("provider_account_model_health_unique_idx").on(
      table.providerAccountId,
      table.model
    ),
    index("provider_account_model_health_accountId_idx").on(table.providerAccountId),
  ]
);

export const providerAccountDisabledModel = pgTable(
  "provider_account_disabled_model",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId()),
    providerAccountId: text("providerAccountId")
      .notNull()
      .references(() => providerAccount.id, { onDelete: "cascade" }),
    model: text("model").notNull(),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("provider_account_disabled_model_unique_idx").on(
      table.providerAccountId,
      table.model
    ),
    index("provider_account_disabled_model_accountId_idx").on(table.providerAccountId),
  ]
);

export const pinnedProvider = pgTable(
  "pinned_provider",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId()),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("pinned_provider_userId_provider_idx").on(table.userId, table.provider),
    index("pinned_provider_userId_idx").on(table.userId),
  ]
);

export type ProviderAccount = typeof providerAccount.$inferSelect;
export type ProviderAccountModelHealth = typeof providerAccountModelHealth.$inferSelect;
export type ProviderAccountDisabledModel = typeof providerAccountDisabledModel.$inferSelect;
export type PinnedProvider = typeof pinnedProvider.$inferSelect;
