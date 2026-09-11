ALTER TABLE "provider_account_model_health" ADD COLUMN "quotaLockedUntil" timestamp;--> statement-breakpoint
ALTER TABLE "provider_account_model_health" ADD COLUMN "quotaLockReason" text;