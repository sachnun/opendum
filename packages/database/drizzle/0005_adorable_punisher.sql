CREATE TABLE "provider_email_registry" (
	"email" text PRIMARY KEY NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_point_balance" ADD COLUMN "rewardsExcluded" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user_point_balance" ADD COLUMN "rewardsExcludedReason" text;--> statement-breakpoint
INSERT INTO "provider_email_registry" ("email", "createdAt", "updatedAt")
SELECT DISTINCT
  regexp_replace(lower(btrim("email")), '\+[^@]*@', '@'),
  now(),
  now()
FROM "provider_account"
WHERE "email" LIKE '%@%'
ON CONFLICT ("email") DO NOTHING;
