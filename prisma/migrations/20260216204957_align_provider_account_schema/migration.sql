/*
  Warnings:

  - You are about to drop the column `iflowAccountId` on the `UsageLog` table. All the data in the column will be lost.
  - You are about to drop the `IflowAccount` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "IflowAccount" DROP CONSTRAINT "IflowAccount_userId_fkey";

-- DropForeignKey
ALTER TABLE "UsageLog" DROP CONSTRAINT "UsageLog_iflowAccountId_fkey";

-- DropIndex
DROP INDEX "UsageLog_iflowAccountId_idx";

-- AlterTable
ALTER TABLE "ProxyApiKey" ADD COLUMN     "expiresAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "UsageLog" DROP COLUMN "iflowAccountId",
ADD COLUMN     "providerAccountId" TEXT;

-- DropTable
DROP TABLE "IflowAccount";

-- CreateTable
CREATE TABLE "ProviderAccount" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "apiKey" TEXT,
    "projectId" TEXT,
    "tier" TEXT,
    "accountId" TEXT,
    "email" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastUsedAt" TIMESTAMP(3),
    "requestCount" INTEGER NOT NULL DEFAULT 0,
    "errorCount" INTEGER NOT NULL DEFAULT 0,
    "consecutiveErrors" INTEGER NOT NULL DEFAULT 0,
    "lastErrorAt" TIMESTAMP(3),
    "lastErrorMessage" TEXT,
    "lastErrorCode" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'active',
    "statusReason" TEXT,
    "statusChangedAt" TIMESTAMP(3),
    "successCount" INTEGER NOT NULL DEFAULT 0,
    "lastSuccessAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderAccount_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProviderAccount_userId_idx" ON "ProviderAccount"("userId");

-- CreateIndex
CREATE INDEX "ProviderAccount_userId_provider_isActive_idx" ON "ProviderAccount"("userId", "provider", "isActive");

-- CreateIndex
CREATE INDEX "ProviderAccount_userId_provider_isActive_status_idx" ON "ProviderAccount"("userId", "provider", "isActive", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderAccount_userId_provider_email_key" ON "ProviderAccount"("userId", "provider", "email");

-- CreateIndex
CREATE INDEX "UsageLog_providerAccountId_idx" ON "UsageLog"("providerAccountId");

-- AddForeignKey
ALTER TABLE "ProviderAccount" ADD CONSTRAINT "ProviderAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageLog" ADD CONSTRAINT "UsageLog_providerAccountId_fkey" FOREIGN KEY ("providerAccountId") REFERENCES "ProviderAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
