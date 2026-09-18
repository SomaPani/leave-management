-- CreateEnum
CREATE TYPE "CompOffSource" AS ENUM ('CLAIM', 'ADMIN_GRANT');

-- AlterTable
ALTER TABLE "CompOffClaim" ADD COLUMN     "source" "CompOffSource" NOT NULL DEFAULT 'CLAIM';

-- CreateIndex
CREATE INDEX "CompOffClaim_organizationId_source_createdAt_idx" ON "CompOffClaim"("organizationId", "source", "createdAt");
