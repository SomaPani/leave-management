-- Decisions: who approved or rejected a request, when, and why.
--
-- Every object is schema-qualified rather than relying on the `schema=orgapp`
-- parameter to set the search path — same rule as every migration before it.

-- AlterTable
-- All three are nullable and every existing row is PENDING, for which null is
-- the correct value. No backfill.
ALTER TABLE "orgapp"."LeaveRequest"
  ADD COLUMN "decidedAt" TIMESTAMP(3),
  ADD COLUMN "decidedById" TEXT,
  ADD COLUMN "decisionNote" TEXT;

-- SetNull, not Restrict: this is attribution, not ownership. An admin who
-- leaves is deleted, and neither blocking that delete nor destroying the
-- organization's leave history with it is acceptable — the same reasoning
-- "LeaveRequest_approverId_fkey" and "Attendance_markedById_fkey" follow.
ALTER TABLE "orgapp"."LeaveRequest"
  ADD CONSTRAINT "LeaveRequest_decidedById_fkey"
  FOREIGN KEY ("decidedById") REFERENCES "orgapp"."User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- The approvals queue reads one organization filtered by status, oldest
-- filing first. The existing [organizationId, startDate] index is on the
-- wrong column for both the filter and the sort.
CREATE INDEX "LeaveRequest_organizationId_status_createdAt_idx"
  ON "orgapp"."LeaveRequest"("organizationId", "status", "createdAt");
