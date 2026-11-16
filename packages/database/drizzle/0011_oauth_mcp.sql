CREATE TABLE "oauth_code" (
	"id" text PRIMARY KEY NOT NULL,
	"codeHash" text NOT NULL,
	"clientId" text NOT NULL,
	"userId" text NOT NULL,
	"redirectUri" text NOT NULL,
	"scope" text NOT NULL,
	"resource" text NOT NULL,
	"codeChallenge" text NOT NULL,
	"codeChallengeMethod" text NOT NULL,
	"expiresAt" timestamp NOT NULL,
	"usedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_code_codeHash_unique" UNIQUE("codeHash")
);
--> statement-breakpoint
CREATE TABLE "oauth_refresh_token" (
	"id" text PRIMARY KEY NOT NULL,
	"tokenHash" text NOT NULL,
	"clientId" text NOT NULL,
	"userId" text NOT NULL,
	"scope" text NOT NULL,
	"resource" text NOT NULL,
	"expiresAt" timestamp NOT NULL,
	"revokedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_refresh_token_tokenHash_unique" UNIQUE("tokenHash")
);
--> statement-breakpoint
CREATE TABLE "oauth_signing_key" (
	"id" text PRIMARY KEY NOT NULL,
	"alg" text NOT NULL,
	"crv" text,
	"publicKey" text NOT NULL,
	"privateKey" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"expiresAt" timestamp
);
--> statement-breakpoint
ALTER TABLE "oauth_code" ADD CONSTRAINT "oauth_code_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" ADD CONSTRAINT "oauth_refresh_token_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
