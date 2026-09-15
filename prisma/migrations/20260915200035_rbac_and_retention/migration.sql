-- AlterTable
ALTER TABLE "media_asset" ADD COLUMN     "deletedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "staff_user" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "retention_settings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "rawMediaRetentionDays" INTEGER NOT NULL DEFAULT 90,
    "fundedEmailEvidenceRetentionDays" INTEGER NOT NULL DEFAULT 180,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "retention_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "staff_user_tokenHash_key" ON "staff_user"("tokenHash");
