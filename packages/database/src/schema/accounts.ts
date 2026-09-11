import { createId } from "@paralleldrive/cuid2";
import type { InferSelectModel } from "drizzle-orm";
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

    // Encrypted credentials (AES-256)
    accessToken: text("accessToken").notNull(),
    refreshToken: text("refreshToken").notNull(),
    expiresAt: timestamp("expiresAt").notNull(),

    // Provider-specific fields
    apiKey: text("apiKey"),
    projectId: text("projectId"),
    tier: text("tier"),
    accountId: text("accountId"),

    // Account info
    email: text("email"),
    isActive: boolean("isActive").notNull().default(true),
    disabledUntil: timestamp("disabledUntil"),

    // Usage tracking
    lastUsedAt: timestamp("lastUsedAt"),
    requestCount: integer("requestCount").notNull().default(0),

    // Error tracking
    errorCount: integer("errorCount").notNull().default(0),
    consecutiveErrors: integer("consecutiveErrors").notNull().default(0),
    lastErrorAt: timestamp("lastErrorAt"),
    lastErrorCode: integer("lastErrorCode"),
    lastRecoveredByRotationAt: timestamp("lastRecoveredByRotationAt"),

    // Health status
    status: text("status").notNull().default("active"),
    statusChangedAt: timestamp("statusChangedAt"),

    // Success metrics
    successCount: integer("successCount").notNull().default(0),
    lastSuccessAt: timestamp("lastSuccessAt"),

    createdAt: timestamp("createdAt").notNull().defaultNow(),
    updatedAt: timestamp("updatedAt")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("provider_account_userId_provider_email_key").on(
      table.userId,
      table.provider,
      table.email,
    ),
    index("provider_account_userId_idx").on(table.userId),
    index("provider_account_userId_provider_isActive_idx").on(
      table.userId,
      table.provider,
      table.isActive,
    ),
    index("provider_account_userId_provider_isActive_status_idx").on(
      table.userId,
      table.provider,
      table.isActive,
      table.status,
    ),
  ],
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
    updatedAt: timestamp("updatedAt")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("provider_account_model_health_accountId_model_key").on(
      table.providerAccountId,
      table.model,
    ),
    index("provider_account_model_health_providerAccountId_idx").on(
      table.providerAccountId,
    ),
    index("provider_account_model_health_providerAccountId_status_idx").on(
      table.providerAccountId,
      table.model,
      table.status,
    ),
  ],
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
    uniqueIndex("provider_account_disabled_model_accountId_model_key").on(
      table.providerAccountId,
      table.model,
    ),
    index("provider_account_disabled_model_providerAccountId_idx").on(
      table.providerAccountId,
    ),
  ],
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
    providerKey: text("providerKey").notNull(),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("pinned_provider_userId_providerKey_key").on(
      table.userId,
      table.providerKey,
    ),
    index("pinned_provider_userId_idx").on(table.userId),
  ],
);

export type ProviderAccount = InferSelectModel<typeof providerAccount>;
