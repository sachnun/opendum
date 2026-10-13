import { createId } from "@paralleldrive/cuid2";
import { boolean, index, integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
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
    uniqueIndex("disabled_model_userId_model_key").on(
      table.userId,
      table.model,
    ),
    index("disabled_model_userId_idx").on(table.userId),
  ],
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
    encryptedKey: text("encryptedKey"),
    name: text("name"),

    modelAccessMode: text("modelAccessMode").notNull().default("all"),
    modelAccessList: text("modelAccessList").array().notNull().default([]),

    accountAccessMode: text("accountAccessMode").notNull().default("all"),
    accountAccessList: text("accountAccessList").array().notNull().default([]),

    roamingEnabled: boolean("roamingEnabled").notNull().default(false),

    isActive: boolean("isActive").notNull().default(true),
    expiresAt: timestamp("expiresAt"),
    lastUsedAt: timestamp("lastUsedAt"),

    createdAt: timestamp("createdAt").notNull().defaultNow(),
    updatedAt: timestamp("updatedAt")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [index("proxy_api_key_userId_idx").on(table.userId)],
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
    targetType: text("targetType").notNull().default("model"),
    perMinute: integer("perMinute"),
    perHour: integer("perHour"),
    perDay: integer("perDay"),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    updatedAt: timestamp("updatedAt")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("proxy_api_key_rate_limit_apiKeyId_idx").on(table.apiKeyId),
    uniqueIndex("proxy_api_key_rate_limit_apiKeyId_target_targetType_idx").on(
      table.apiKeyId,
      table.target,
      table.targetType,
    ),
  ],
);
