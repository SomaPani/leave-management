-- CreateEnum
CREATE TYPE "CompOffClaimStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN');

-- AlterEnum
ALTER TYPE "LeaveAccrual" ADD VALUE 'EARNED';

-- CreateTable
CREATE TABLE "CompOffClaim" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "workedOn" DATE NOT NULL,
    "reason" TEXT,
    "status" "CompOffClaimStatus" NOT NULL DEFAULT 'PENDING',
    "approverId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decidedById" TEXT,
    "decisionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CompOffClaim_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CompOffClaim_userId_status_idx" ON "CompOffClaim"("userId", "status");

-- CreateIndex
CREATE INDEX "CompOffClaim_organizationId_status_createdAt_idx" ON "CompOffClaim"("organizationId", "status", "createdAt");

-- AddForeignKey
ALTER TABLE "CompOffClaim" ADD CONSTRAINT "CompOffClaim_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompOffClaim" ADD CONSTRAINT "CompOffClaim_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompOffClaim" ADD CONSTRAINT "CompOffClaim_approverId_fkey" FOREIGN KEY ("approverId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompOffClaim" ADD CONSTRAINT "CompOffClaim_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
