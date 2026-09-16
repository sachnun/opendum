ALTER TABLE "provider_email_registry" DROP CONSTRAINT "provider_email_registry_pkey";--> statement-breakpoint
ALTER TABLE "provider_email_registry" ADD COLUMN "userId" text;--> statement-breakpoint
CREATE UNIQUE INDEX "provider_email_registry_email_userId_key" ON "provider_email_registry" USING btree ("email","userId");--> statement-breakpoint
INSERT INTO "provider_email_registry" ("email", "userId", "createdAt", "updatedAt")
SELECT DISTINCT
  regexp_replace(lower(btrim("email")), '\+[^@]*@', '@'),
  "userId",
  now(),
  now()
FROM "provider_account"
WHERE "email" LIKE '%@%'
ON CONFLICT ("email","userId") DO NOTHING;--> statement-breakpoint
DELETE FROM "provider_email_registry" WHERE "userId" IS NULL;
