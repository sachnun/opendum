import { createId } from "@paralleldrive/cuid2";
import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { user } from "./auth.js";

export const disabledModel = pgTable(
  "disabled_model",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId()),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    model: text("model").notNull(),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("disabled_model_userId_model_idx").on(table.userId, table.model),
    index("disabled_model_userId_idx").on(table.userId),
  ]
);

export const proxyApiKey = pgTable(
  "proxy_api_key",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId()),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    keyHash: text("keyHash").notNull().unique(),
    keyPreview: text("keyPreview").notNull(),
    name: text("name"),
    modelAccessMode: text("modelAccessMode").notNull().default("all"),
    modelAccessList: jsonb("modelAccessList").$type<string[]>().notNull().default([]),
    accountAccessMode: text("accountAccessMode").notNull().default("all"),
    accountAccessList: jsonb("accountAccessList").$type<string[]>().notNull().default([]),
    roamingEnabled: boolean("roamingEnabled").notNull().default(false),
    isActive: boolean("isActive").notNull().default(true),
    expiresAt: timestamp("expiresAt"),
    lastUsedAt: timestamp("lastUsedAt"),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow(),
  },
  (table) => [index("proxy_api_key_userId_idx").on(table.userId)]
);

export const proxyApiKeyRateLimit = pgTable(
  "proxy_api_key_rate_limit",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId()),
    apiKeyId: text("apiKeyId")
      .notNull()
      .references(() => proxyApiKey.id, { onDelete: "cascade" }),
    target: text("target").notNull(),
    targetType: text("targetType").notNull(),
    perMinute: integer("perMinute"),
    perHour: integer("perHour"),
    perDay: integer("perDay"),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("proxy_api_key_rate_limit_unique_idx").on(
      table.apiKeyId,
      table.target,
      table.targetType
    ),
    index("proxy_api_key_rate_limit_apiKeyId_idx").on(table.apiKeyId),
  ]
);

export type DisabledModel = typeof disabledModel.$inferSelect;
export type ProxyApiKey = typeof proxyApiKey.$inferSelect;
export type ProxyApiKeyRateLimit = typeof proxyApiKeyRateLimit.$inferSelect;
