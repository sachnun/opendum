CREATE TABLE "custom_provider" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"baseUrl" text NOT NULL,
	"extraHeaders" jsonb,
	"enabled" boolean DEFAULT true NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "custom_provider_model" (
	"id" text PRIMARY KEY NOT NULL,
	"providerId" text NOT NULL,
	"modelId" text NOT NULL,
	"upstream" text,
	"authless" boolean DEFAULT false NOT NULL,
	"minTier" text,
	"allowedTiers" text[],
	"meta" jsonb,
	"customFlags" jsonb,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "custom_provider" ADD CONSTRAINT "custom_provider_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "custom_provider_model" ADD CONSTRAINT "custom_provider_model_providerId_custom_provider_id_fk" FOREIGN KEY ("providerId") REFERENCES "public"."custom_provider"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "custom_provider_userId_slug_key" ON "custom_provider" USING btree ("userId","slug");
--> statement-breakpoint
CREATE INDEX "custom_provider_userId_idx" ON "custom_provider" USING btree ("userId");
--> statement-breakpoint
CREATE UNIQUE INDEX "custom_provider_model_providerId_modelId_key" ON "custom_provider_model" USING btree ("providerId","modelId");
--> statement-breakpoint
CREATE INDEX "custom_provider_model_providerId_idx" ON "custom_provider_model" USING btree ("providerId");
