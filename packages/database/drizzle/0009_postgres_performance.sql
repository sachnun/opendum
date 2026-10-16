CREATE EXTENSION IF NOT EXISTS pg_stat_statements;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_partman;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pgstattuple;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_prewarm;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS bloom;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS btree_gin;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS hll;--> statement-breakpoint
ALTER TABLE "point_transaction" DROP CONSTRAINT "point_transaction_usageLogId_usage_log_id_fk";--> statement-breakpoint
DROP INDEX "point_transaction_usageLogId_idx";--> statement-breakpoint
ALTER TABLE "usage_log" DROP CONSTRAINT "usage_log_pkey";--> statement-breakpoint
DROP INDEX "usage_log_userId_createdAt_idx";--> statement-breakpoint
DROP INDEX "usage_log_userId_providerAccountId_createdAt_idx";--> statement-breakpoint
DROP INDEX "usage_log_userId_proxyApiKeyId_createdAt_idx";--> statement-breakpoint
DROP INDEX "usage_log_providerAccountId_idx";--> statement-breakpoint
DROP INDEX "usage_log_createdAt_idx";--> statement-breakpoint
CREATE INDEX "usage_log_userId_createdAt_idx" ON "usage_log" USING btree ("userId","createdAt","inputTokens","outputTokens","cachedTokens","cacheWriteTokens","statusCode","duration","providerAccountId","proxyApiKeyId","model");--> statement-breakpoint
ALTER TABLE "usage_log" SET (fillfactor = 100, autovacuum_vacuum_scale_factor = 0.0, autovacuum_vacuum_threshold = 500, autovacuum_analyze_scale_factor = 0.0, autovacuum_analyze_threshold = 500);--> statement-breakpoint
ALTER TABLE "provider_account" SET (fillfactor = 85, autovacuum_vacuum_scale_factor = 0.02, autovacuum_vacuum_threshold = 50, autovacuum_analyze_scale_factor = 0.01, autovacuum_analyze_threshold = 50);--> statement-breakpoint
ALTER TABLE "provider_account_model_health" SET (fillfactor = 85, autovacuum_vacuum_scale_factor = 0.02, autovacuum_vacuum_threshold = 50, autovacuum_analyze_scale_factor = 0.01, autovacuum_analyze_threshold = 50);--> statement-breakpoint
ALTER TABLE "user_point_balance" SET (fillfactor = 85, autovacuum_vacuum_scale_factor = 0.05, autovacuum_analyze_scale_factor = 0.05);--> statement-breakpoint
ALTER TABLE "proxy_api_key" SET (fillfactor = 85);--> statement-breakpoint
ALTER TABLE "user_sharing_setting" SET (fillfactor = 85);--> statement-breakpoint
ALTER TABLE "provider_email_registry" SET (fillfactor = 85);--> statement-breakpoint
DROP INDEX "provider_account_userId_idx";--> statement-breakpoint
DROP INDEX "provider_account_userId_provider_isActive_idx";--> statement-breakpoint
DROP INDEX "provider_account_model_health_providerAccountId_idx";--> statement-breakpoint
DROP INDEX "provider_account_model_health_providerAccountId_status_idx";--> statement-breakpoint
DROP INDEX "provider_account_disabled_model_providerAccountId_idx";--> statement-breakpoint
DROP INDEX "pinned_provider_userId_idx";--> statement-breakpoint
DROP INDEX "disabled_model_userId_idx";--> statement-breakpoint
DROP INDEX "proxy_api_key_rate_limit_apiKeyId_idx";--> statement-breakpoint
CREATE STATISTICS "usage_log_userId_relations" (dependencies, ndistinct) ON "userId","providerAccountId","proxyApiKeyId","model" FROM "usage_log";--> statement-breakpoint
CREATE STATISTICS "provider_account_identity_relations" (dependencies, ndistinct) ON "userId","provider","isActive","status" FROM "provider_account";--> statement-breakpoint
CREATE STATISTICS "provider_account_model_health_relations" (dependencies, ndistinct) ON "providerAccountId","model","status" FROM "provider_account_model_health";--> statement-breakpoint
ANALYZE "usage_log";--> statement-breakpoint
ANALYZE "provider_account";--> statement-breakpoint
ANALYZE "provider_account_model_health";--> statement-breakpoint
ANALYZE "point_transaction";
