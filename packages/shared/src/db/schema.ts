import {
  pgTable,
  text,
  timestamp,
  boolean,
  integer,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createId } from "@paralleldrive/cuid2";
import type { InferSelectModel } from "drizzle-orm";

export const user = pgTable("user", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => createId()),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("emailVerified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  updatedAt: timestamp("updatedAt")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const session = pgTable(
  "session",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId()),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique(),
    expiresAt: timestamp("expiresAt").notNull(),
    ipAddress: text("ipAddress"),
    userAgent: text("userAgent"),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    updatedAt: timestamp("updatedAt")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("session_userId_idx").on(table.userId),
  ],
);

export const account = pgTable(
  "account",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId()),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accountId: text("accountId").notNull(),
    providerId: text("providerId").notNull(),
    accessToken: text("accessToken"),
    refreshToken: text("refreshToken"),
    accessTokenExpiresAt: timestamp("accessTokenExpiresAt"),
    refreshTokenExpiresAt: timestamp("refreshTokenExpiresAt"),
    scope: text("scope"),
    idToken: text("idToken"),
    password: text("password"),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    updatedAt: timestamp("updatedAt")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [index("account_userId_idx").on(table.userId)],
);

export const verification = pgTable(
  "verification",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId()),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expiresAt").notNull(),
    createdAt: timestamp("createdAt").defaultNow(),
    updatedAt: timestamp("updatedAt")
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)],
);

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

    // Usage tracking
    lastUsedAt: timestamp("lastUsedAt"),
    requestCount: integer("requestCount").notNull().default(0),

    // Error tracking
    errorCount: integer("errorCount").notNull().default(0),
    consecutiveErrors: integer("consecutiveErrors").notNull().default(0),
    lastErrorAt: timestamp("lastErrorAt"),
    lastErrorMessage: text("lastErrorMessage"),
    lastErrorCode: integer("lastErrorCode"),

    // Health status
    status: text("status").notNull().default("active"),
    statusReason: text("statusReason"),
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

export const providerAccountErrorHistory = pgTable(
  "provider_account_error_history",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId()),
    providerAccountId: text("providerAccountId")
      .notNull()
      .references(() => providerAccount.id, { onDelete: "cascade" }),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    errorCode: integer("errorCode").notNull(),
    errorMessage: text("errorMessage").notNull(),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
  },
  (table) => [
    index("provider_account_error_history_providerAccountId_idx").on(
      table.providerAccountId,
    ),
    index("provider_account_error_history_providerAccountId_createdAt_idx").on(
      table.providerAccountId,
      table.createdAt,
    ),
    index("provider_account_error_history_userId_createdAt_idx").on(
      table.userId,
      table.createdAt,
    ),
  ],
);

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

    isActive: boolean("isActive").notNull().default(true),
    expiresAt: timestamp("expiresAt"),
    lastUsedAt: timestamp("lastUsedAt"),

    createdAt: timestamp("createdAt").notNull().defaultNow(),
    updatedAt: timestamp("updatedAt")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("proxy_api_key_userId_idx").on(table.userId),
  ],
);

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

export type ProviderAccount = InferSelectModel<typeof providerAccount>;
