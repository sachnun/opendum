ALTER TABLE "usage_log" ADD COLUMN "cachedTokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_log" ADD COLUMN "cacheWriteTokens" integer DEFAULT 0 NOT NULL;