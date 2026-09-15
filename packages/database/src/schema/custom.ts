import { createId } from "@paralleldrive/cuid2";
import { boolean, index, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { user } from "./auth.js";

export const customProvider = pgTable(
  "custom_provider",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId()),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    baseUrl: text("baseUrl").notNull(),
    extraHeaders: jsonb("extraHeaders").$type<Record<string, string>>(),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    updatedAt: timestamp("updatedAt")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("custom_provider_userId_slug_key").on(table.userId, table.slug),
    index("custom_provider_userId_idx").on(table.userId),
  ],
);

export const customProviderModel = pgTable(
  "custom_provider_model",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId()),
    providerId: text("providerId")
      .notNull()
      .references(() => customProvider.id, { onDelete: "cascade" }),
    modelId: text("modelId").notNull(),
    upstream: text("upstream"),
    authless: boolean("authless").notNull().default(false),
    minTier: text("minTier"),
    allowedTiers: text("allowedTiers").array(),
    meta: jsonb("meta").$type<{
      reasoning?: boolean;
      toolCall?: boolean;
      vision?: boolean;
    }>(),
    customFlags: jsonb("customFlags").$type<{
      responses_api?: boolean;
      top_p_deprecated?: boolean;
      convert_external_images?: boolean;
    }>(),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    updatedAt: timestamp("updatedAt")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("custom_provider_model_providerId_modelId_key").on(
      table.providerId,
      table.modelId,
    ),
    index("custom_provider_model_providerId_idx").on(table.providerId),
  ],
);
