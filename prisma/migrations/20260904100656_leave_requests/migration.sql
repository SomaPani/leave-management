-- Leave policies and leave requests, per organization.
--
-- Every object is schema-qualified rather than relying on the `schema=orgapp`
-- parameter to set the search path — same rule as every migration before it.

-- CreateEnum
CREATE TYPE "orgapp"."LeaveUnit" AS ENUM ('DAYS', 'USES');

-- CreateEnum
CREATE TYPE "orgapp"."LeaveRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN');

-- CreateTable
CREATE TABLE "orgapp"."LeavePolicy" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "note" TEXT,
    "allowance" INTEGER NOT NULL,
    "unit" "orgapp"."LeaveUnit" NOT NULL DEFAULT 'DAYS',
    "carry" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeavePolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orgapp"."LeaveRequest" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "cost" INTEGER NOT NULL,
    "reason" TEXT,
    "status" "orgapp"."LeaveRequestStatus" NOT NULL DEFAULT 'PENDING',
    "approverId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeaveRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LeavePolicy_organizationId_name_key" ON "orgapp"."LeavePolicy"("organizationId", "name");

-- CreateIndex
CREATE INDEX "LeavePolicy_organizationId_idx" ON "orgapp"."LeavePolicy"("organizationId");

-- CreateIndex
CREATE INDEX "LeaveRequest_organizationId_startDate_idx" ON "orgapp"."LeaveRequest"("organizationId", "startDate");

-- CreateIndex
CREATE INDEX "LeaveRequest_userId_status_idx" ON "orgapp"."LeaveRequest"("userId", "status");

-- AddForeignKey
ALTER TABLE "orgapp"."LeavePolicy" ADD CONSTRAINT "LeavePolicy_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "orgapp"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orgapp"."LeaveRequest" ADD CONSTRAINT "LeaveRequest_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "orgapp"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orgapp"."LeaveRequest" ADD CONSTRAINT "LeaveRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "orgapp"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- Restrict, not Cascade: a policy with requests against it is retired
-- (active = false), never deleted, or a year of pricing loses its meaning.
ALTER TABLE "orgapp"."LeaveRequest" ADD CONSTRAINT "LeaveRequest_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "orgapp"."LeavePolicy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
-- SetNull, like Attendance.markedById: this is routing, not ownership. An
-- approver who leaves must not block their own deletion nor take the team's
-- leave history with them.
ALTER TABLE "orgapp"."LeaveRequest" ADD CONSTRAINT "LeaveRequest_approverId_fkey" FOREIGN KEY ("approverId") REFERENCES "orgapp"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- An allowance is a count, not a signed quantity.
ALTER TABLE "orgapp"."LeavePolicy"
  ADD CONSTRAINT "LeavePolicy_allowance_nonnegative" CHECK ("allowance" >= 0);

-- The range is inclusive and ordered. Prisma's schema language cannot say so.
ALTER TABLE "orgapp"."LeaveRequest"
  ADD CONSTRAINT "LeaveRequest_range_ordered" CHECK ("endDate" >= "startDate");

-- Zero is legal — an all-weekend range costs nothing and is still a filing.
-- Negative is not.
ALTER TABLE "orgapp"."LeaveRequest"
  ADD CONSTRAINT "LeaveRequest_cost_nonnegative" CHECK ("cost" >= 0);
