-- AlterTable
ALTER TABLE "ProxyApiKey"
ADD COLUMN "modelAccessMode" TEXT NOT NULL DEFAULT 'all',
ADD COLUMN "modelAccessList" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
