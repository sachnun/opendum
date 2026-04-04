CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"accountId" text NOT NULL,
	"providerId" text NOT NULL,
	"accessToken" text,
	"refreshToken" text,
	"accessTokenExpiresAt" timestamp,
	"refreshTokenExpiresAt" timestamp,
	"scope" text,
	"idToken" text,
	"password" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "disabled_model" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"model" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pinned_provider" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"providerKey" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_account" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"provider" text NOT NULL,
	"name" text NOT NULL,
	"accessToken" text NOT NULL,
	"refreshToken" text NOT NULL,
	"expiresAt" timestamp NOT NULL,
	"apiKey" text,
	"projectId" text,
	"tier" text,
	"accountId" text,
	"email" text,
	"isActive" boolean DEFAULT true NOT NULL,
	"lastUsedAt" timestamp,
	"requestCount" integer DEFAULT 0 NOT NULL,
	"errorCount" integer DEFAULT 0 NOT NULL,
	"consecutiveErrors" integer DEFAULT 0 NOT NULL,
	"lastErrorAt" timestamp,
	"lastErrorMessage" text,
	"lastErrorCode" integer,
	"status" text DEFAULT 'active' NOT NULL,
	"statusReason" text,
	"statusChangedAt" timestamp,
	"successCount" integer DEFAULT 0 NOT NULL,
	"lastSuccessAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_account_disabled_model" (
	"id" text PRIMARY KEY NOT NULL,
	"providerAccountId" text NOT NULL,
	"model" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_account_error_history" (
	"id" text PRIMARY KEY NOT NULL,
	"providerAccountId" text NOT NULL,
	"userId" text NOT NULL,
	"model" text,
	"errorCode" integer NOT NULL,
	"errorMessage" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_account_model_health" (
	"id" text PRIMARY KEY NOT NULL,
	"providerAccountId" text NOT NULL,
	"model" text NOT NULL,
	"consecutiveErrors" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"statusReason" text,
	"statusChangedAt" timestamp,
	"lastErrorAt" timestamp,
	"lastErrorCode" integer,
	"lastErrorMessage" text,
	"lastSuccessAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "proxy_api_key" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"keyHash" text NOT NULL,
	"keyPreview" text NOT NULL,
	"encryptedKey" text,
	"name" text,
	"modelAccessMode" text DEFAULT 'all' NOT NULL,
	"modelAccessList" text[] DEFAULT '{}' NOT NULL,
	"accountAccessMode" text DEFAULT 'all' NOT NULL,
	"accountAccessList" text[] DEFAULT '{}' NOT NULL,
	"isActive" boolean DEFAULT true NOT NULL,
	"expiresAt" timestamp,
	"lastUsedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "proxy_api_key_keyHash_unique" UNIQUE("keyHash")
);
--> statement-breakpoint
CREATE TABLE "proxy_api_key_rate_limit" (
	"id" text PRIMARY KEY NOT NULL,
	"apiKeyId" text NOT NULL,
	"target" text NOT NULL,
	"targetType" text DEFAULT 'model' NOT NULL,
	"perMinute" integer,
	"perHour" integer,
	"perDay" integer,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"token" text NOT NULL,
	"expiresAt" timestamp NOT NULL,
	"ipAddress" text,
	"userAgent" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "usage_log" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"providerAccountId" text,
	"proxyApiKeyId" text,
	"model" text NOT NULL,
	"inputTokens" integer DEFAULT 0 NOT NULL,
	"outputTokens" integer DEFAULT 0 NOT NULL,
	"statusCode" integer,
	"duration" integer,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"emailVerified" boolean DEFAULT false NOT NULL,
	"image" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expiresAt" timestamp NOT NULL,
	"createdAt" timestamp DEFAULT now(),
	"updatedAt" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disabled_model" ADD CONSTRAINT "disabled_model_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pinned_provider" ADD CONSTRAINT "pinned_provider_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_account" ADD CONSTRAINT "provider_account_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_account_disabled_model" ADD CONSTRAINT "provider_account_disabled_model_providerAccountId_provider_account_id_fk" FOREIGN KEY ("providerAccountId") REFERENCES "public"."provider_account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_account_error_history" ADD CONSTRAINT "provider_account_error_history_providerAccountId_provider_account_id_fk" FOREIGN KEY ("providerAccountId") REFERENCES "public"."provider_account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_account_error_history" ADD CONSTRAINT "provider_account_error_history_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_account_model_health" ADD CONSTRAINT "provider_account_model_health_providerAccountId_provider_account_id_fk" FOREIGN KEY ("providerAccountId") REFERENCES "public"."provider_account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proxy_api_key" ADD CONSTRAINT "proxy_api_key_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proxy_api_key_rate_limit" ADD CONSTRAINT "proxy_api_key_rate_limit_apiKeyId_proxy_api_key_id_fk" FOREIGN KEY ("apiKeyId") REFERENCES "public"."proxy_api_key"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_log" ADD CONSTRAINT "usage_log_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_log" ADD CONSTRAINT "usage_log_providerAccountId_provider_account_id_fk" FOREIGN KEY ("providerAccountId") REFERENCES "public"."provider_account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_log" ADD CONSTRAINT "usage_log_proxyApiKeyId_proxy_api_key_id_fk" FOREIGN KEY ("proxyApiKeyId") REFERENCES "public"."proxy_api_key"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" USING btree ("userId");--> statement-breakpoint
CREATE UNIQUE INDEX "disabled_model_userId_model_key" ON "disabled_model" USING btree ("userId","model");--> statement-breakpoint
CREATE INDEX "disabled_model_userId_idx" ON "disabled_model" USING btree ("userId");--> statement-breakpoint
CREATE UNIQUE INDEX "pinned_provider_userId_providerKey_key" ON "pinned_provider" USING btree ("userId","providerKey");--> statement-breakpoint
CREATE INDEX "pinned_provider_userId_idx" ON "pinned_provider" USING btree ("userId");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_account_userId_provider_email_key" ON "provider_account" USING btree ("userId","provider","email");--> statement-breakpoint
CREATE INDEX "provider_account_userId_idx" ON "provider_account" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "provider_account_userId_provider_isActive_idx" ON "provider_account" USING btree ("userId","provider","isActive");--> statement-breakpoint
CREATE INDEX "provider_account_userId_provider_isActive_status_idx" ON "provider_account" USING btree ("userId","provider","isActive","status");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_account_disabled_model_accountId_model_key" ON "provider_account_disabled_model" USING btree ("providerAccountId","model");--> statement-breakpoint
CREATE INDEX "provider_account_disabled_model_providerAccountId_idx" ON "provider_account_disabled_model" USING btree ("providerAccountId");--> statement-breakpoint
CREATE INDEX "provider_account_error_history_providerAccountId_idx" ON "provider_account_error_history" USING btree ("providerAccountId");--> statement-breakpoint
CREATE INDEX "provider_account_error_history_providerAccountId_createdAt_idx" ON "provider_account_error_history" USING btree ("providerAccountId","createdAt");--> statement-breakpoint
CREATE INDEX "provider_account_error_history_userId_createdAt_idx" ON "provider_account_error_history" USING btree ("userId","createdAt");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_account_model_health_accountId_model_key" ON "provider_account_model_health" USING btree ("providerAccountId","model");--> statement-breakpoint
CREATE INDEX "provider_account_model_health_providerAccountId_idx" ON "provider_account_model_health" USING btree ("providerAccountId");--> statement-breakpoint
CREATE INDEX "provider_account_model_health_providerAccountId_status_idx" ON "provider_account_model_health" USING btree ("providerAccountId","model","status");--> statement-breakpoint
CREATE INDEX "proxy_api_key_userId_idx" ON "proxy_api_key" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "proxy_api_key_rate_limit_apiKeyId_idx" ON "proxy_api_key_rate_limit" USING btree ("apiKeyId");--> statement-breakpoint
CREATE UNIQUE INDEX "proxy_api_key_rate_limit_apiKeyId_target_targetType_idx" ON "proxy_api_key_rate_limit" USING btree ("apiKeyId","target","targetType");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "session" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "usage_log_userId_createdAt_idx" ON "usage_log" USING btree ("userId","createdAt");--> statement-breakpoint
CREATE INDEX "usage_log_userId_providerAccountId_createdAt_idx" ON "usage_log" USING btree ("userId","providerAccountId","createdAt");--> statement-breakpoint
CREATE INDEX "usage_log_userId_proxyApiKeyId_createdAt_idx" ON "usage_log" USING btree ("userId","proxyApiKeyId","createdAt");--> statement-breakpoint
CREATE INDEX "usage_log_providerAccountId_idx" ON "usage_log" USING btree ("providerAccountId");--> statement-breakpoint
CREATE INDEX "usage_log_createdAt_idx" ON "usage_log" USING btree ("createdAt");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");