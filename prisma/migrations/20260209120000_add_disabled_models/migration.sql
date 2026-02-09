-- CreateTable
CREATE TABLE "DisabledModel" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DisabledModel_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DisabledModel_userId_model_key" ON "DisabledModel"("userId", "model");

-- CreateIndex
CREATE INDEX "DisabledModel_userId_idx" ON "DisabledModel"("userId");

-- AddForeignKey
ALTER TABLE "DisabledModel" ADD CONSTRAINT "DisabledModel_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
