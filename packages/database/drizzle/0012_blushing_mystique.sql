CREATE TABLE "oauth_access_token" (
	"id" text PRIMARY KEY NOT NULL,
	"token" text,
	"clientId" text NOT NULL,
	"sessionId" text,
	"userId" text,
	"referenceId" text,
	"authorizationCodeId" text,
	"resources" text[],
	"requestedUserInfoClaims" text[],
	"refreshId" text,
	"expiresAt" timestamp NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"revoked" timestamp,
	"confirmation" jsonb,
	"scopes" text[] NOT NULL,
	CONSTRAINT "oauth_access_token_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "oauth_client" (
	"id" text PRIMARY KEY NOT NULL,
	"clientId" text NOT NULL,
	"clientSecret" text,
	"clientDiscoveryId" text,
	"disabled" boolean DEFAULT false NOT NULL,
	"skipConsent" boolean,
	"enableEndSession" boolean,
	"subjectType" text,
	"scopes" text[],
	"clientCredentialsScopes" text[],
	"userId" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"name" text,
	"uri" text,
	"icon" text,
	"contacts" text[],
	"tos" text,
	"policy" text,
	"softwareId" text,
	"softwareVersion" text,
	"softwareStatement" text,
	"redirectUris" text[] NOT NULL,
	"postLogoutRedirectUris" text[],
	"backchannelLogoutUri" text,
	"backchannelLogoutSessionRequired" boolean,
	"tokenEndpointAuthMethod" text,
	"applicationType" text,
	"jwks" text,
	"jwksUri" text,
	"grantTypes" text[],
	"responseTypes" text[],
	"requirePKCE" boolean,
	"dpopBoundAccessTokens" boolean DEFAULT false NOT NULL,
	"referenceId" text,
	"metadata" jsonb,
	CONSTRAINT "oauth_client_clientId_unique" UNIQUE("clientId")
);
--> statement-breakpoint
CREATE TABLE "oauth_client_assertion" (
	"id" text PRIMARY KEY NOT NULL,
	"expiresAt" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_client_resource" (
	"id" text PRIMARY KEY NOT NULL,
	"clientId" text NOT NULL,
	"resourceId" text NOT NULL,
	"metadata" jsonb,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_consent" (
	"id" text PRIMARY KEY NOT NULL,
	"clientId" text NOT NULL,
	"userId" text,
	"referenceId" text,
	"resources" text[],
	"requestedUserInfoClaims" text[],
	"scopes" text[] NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_resource" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"name" text NOT NULL,
	"accessTokenTtl" integer,
	"refreshTokenTtl" integer,
	"signingAlgorithm" text,
	"signingKeyId" text,
	"allowedScopes" text[],
	"customClaims" jsonb,
	"dpopBoundAccessTokensRequired" boolean DEFAULT false NOT NULL,
	"disabled" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"policyVersion" integer DEFAULT 1 NOT NULL,
	"metadata" jsonb,
	CONSTRAINT "oauth_resource_identifier_unique" UNIQUE("identifier")
);
--> statement-breakpoint
ALTER TABLE "oauth_code" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "oauth_signing_key" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "oauth_code" CASCADE;--> statement-breakpoint
DROP TABLE "oauth_signing_key" CASCADE;--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" DROP CONSTRAINT "oauth_refresh_token_tokenHash_unique";--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" ADD COLUMN "token" text NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" ADD COLUMN "sessionId" text;--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" ADD COLUMN "referenceId" text;--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" ADD COLUMN "authorizationCodeId" text;--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" ADD COLUMN "resources" text[];--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" ADD COLUMN "requestedUserInfoClaims" text[];--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" ADD COLUMN "revoked" timestamp;--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" ADD COLUMN "rotatedAt" timestamp;--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" ADD COLUMN "rotationReplayResponse" text;--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" ADD COLUMN "rotationReplayExpiresAt" timestamp;--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" ADD COLUMN "authTime" timestamp;--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" ADD COLUMN "confirmation" jsonb;--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" ADD COLUMN "scopes" text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_access_token" ADD CONSTRAINT "oauth_access_token_clientId_oauth_client_clientId_fk" FOREIGN KEY ("clientId") REFERENCES "public"."oauth_client"("clientId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_access_token" ADD CONSTRAINT "oauth_access_token_sessionId_session_id_fk" FOREIGN KEY ("sessionId") REFERENCES "public"."session"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_access_token" ADD CONSTRAINT "oauth_access_token_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_access_token" ADD CONSTRAINT "oauth_access_token_refreshId_oauth_refresh_token_id_fk" FOREIGN KEY ("refreshId") REFERENCES "public"."oauth_refresh_token"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_client" ADD CONSTRAINT "oauth_client_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_client_resource" ADD CONSTRAINT "oauth_client_resource_clientId_oauth_client_clientId_fk" FOREIGN KEY ("clientId") REFERENCES "public"."oauth_client"("clientId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_client_resource" ADD CONSTRAINT "oauth_client_resource_resourceId_oauth_resource_identifier_fk" FOREIGN KEY ("resourceId") REFERENCES "public"."oauth_resource"("identifier") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_consent" ADD CONSTRAINT "oauth_consent_clientId_oauth_client_clientId_fk" FOREIGN KEY ("clientId") REFERENCES "public"."oauth_client"("clientId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_consent" ADD CONSTRAINT "oauth_consent_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "oauth_access_token_clientId_idx" ON "oauth_access_token" USING btree ("clientId");--> statement-breakpoint
CREATE INDEX "oauth_access_token_sessionId_idx" ON "oauth_access_token" USING btree ("sessionId");--> statement-breakpoint
CREATE INDEX "oauth_access_token_userId_idx" ON "oauth_access_token" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "oauth_access_token_authorizationCodeId_idx" ON "oauth_access_token" USING btree ("authorizationCodeId");--> statement-breakpoint
CREATE INDEX "oauth_access_token_refreshId_idx" ON "oauth_access_token" USING btree ("refreshId");--> statement-breakpoint
CREATE INDEX "oauth_client_userId_idx" ON "oauth_client" USING btree ("userId");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_client_resource_clientId_resourceId_key" ON "oauth_client_resource" USING btree ("clientId","resourceId");--> statement-breakpoint
CREATE INDEX "oauth_client_resource_resourceId_idx" ON "oauth_client_resource" USING btree ("resourceId");--> statement-breakpoint
CREATE INDEX "oauth_consent_clientId_idx" ON "oauth_consent" USING btree ("clientId");--> statement-breakpoint
CREATE INDEX "oauth_consent_userId_idx" ON "oauth_consent" USING btree ("userId");--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" ADD CONSTRAINT "oauth_refresh_token_clientId_oauth_client_clientId_fk" FOREIGN KEY ("clientId") REFERENCES "public"."oauth_client"("clientId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" ADD CONSTRAINT "oauth_refresh_token_sessionId_session_id_fk" FOREIGN KEY ("sessionId") REFERENCES "public"."session"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "oauth_refresh_token_clientId_idx" ON "oauth_refresh_token" USING btree ("clientId");--> statement-breakpoint
CREATE INDEX "oauth_refresh_token_sessionId_idx" ON "oauth_refresh_token" USING btree ("sessionId");--> statement-breakpoint
CREATE INDEX "oauth_refresh_token_userId_idx" ON "oauth_refresh_token" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "oauth_refresh_token_authorizationCodeId_idx" ON "oauth_refresh_token" USING btree ("authorizationCodeId");--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" DROP COLUMN "tokenHash";--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" DROP COLUMN "scope";--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" DROP COLUMN "resource";--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" DROP COLUMN "revokedAt";--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" ADD CONSTRAINT "oauth_refresh_token_token_unique" UNIQUE("token");--> statement-breakpoint
INSERT INTO "oauth_client" ("id", "clientId", "disabled", "skipConsent", "redirectUris", "grantTypes", "responseTypes", "tokenEndpointAuthMethod", "applicationType", "name", "createdAt", "updatedAt") VALUES ('oauthclient_opencode', 'opencode', false, true, ARRAY['http://127.0.0.1/callback','http://localhost/callback','http://[::1]/callback','http://127.0.0.1/mcp/oauth/callback','http://localhost/mcp/oauth/callback','http://[::1]/mcp/oauth/callback'], ARRAY['authorization_code','refresh_token'], ARRAY['code'], 'none', 'native', 'OpenCode', now(), now()) ON CONFLICT ("clientId") DO NOTHING;