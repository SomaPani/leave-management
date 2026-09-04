-- Accrual: how a leave entitlement arrives, rather than merely how much of it
-- there is.
--
-- Every object is schema-qualified rather than relying on the `schema=orgapp`
-- parameter to set the search path — same rule as every migration before it.

-- CreateEnum
CREATE TYPE "orgapp"."LeaveAccrual" AS ENUM ('UPFRONT', 'MONTHLY');

-- AlterTable
-- Three columns carry defaults, so existing rows are already correct as
-- UPFRONT, un-prorated and uncapped. `effectiveFrom` cannot: it is NOT NULL
-- with no sensible default, so it arrives nullable and is tightened below.
ALTER TABLE "orgapp"."LeavePolicy"
  ADD COLUMN "accrual" "orgapp"."LeaveAccrual" NOT NULL DEFAULT 'UPFRONT',
  ADD COLUMN "prorated" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "cap" INTEGER,
  ADD COLUMN "effectiveFrom" DATE;

-- The leave scheme goes live on this date. Every policy that already exists
-- predates the concept, so all of them start here; policies created after this
-- migration set their own.
UPDATE "orgapp"."LeavePolicy"
  SET "effectiveFrom" = DATE '2026-09-01'
  WHERE "effectiveFrom" IS NULL;

ALTER TABLE "orgapp"."LeavePolicy" ALTER COLUMN "effectiveFrom" SET NOT NULL;

-- Casual becomes CL, renamed in place: the same entitlement at the same six
-- days, so every request already filed against it stays valid and attached.
-- It gains pro-rating, which is what makes 2026 a two-day year.
UPDATE "orgapp"."LeavePolicy"
  SET "name" = 'Casual Leave (CL)',
      "note" = 'Six days a year, credited in full on 1 January.',
      "prorated" = true
  WHERE "name" = 'Casual';

-- Withdrawn. Retired rather than deleted, because LeaveRequest.policyId is
-- ON DELETE RESTRICT and any request ever filed against these has to stay
-- readable. "Paid / annual" is deliberately NOT converted into EL: its
-- entitlement changes from 18 days to 12 and its crediting rule changes
-- entirely, so reusing the row would misdescribe its own history.
UPDATE "orgapp"."LeavePolicy"
  SET "active" = false
  WHERE "name" IN ('Sick', 'Paid / annual');

-- A MONTHLY policy credits allowance/12 each month into an INTEGER column.
-- An allowance of 13 would credit 1.083 days and round in silence, so the
-- configuration is refused rather than the arithmetic fudged.
ALTER TABLE "orgapp"."LeavePolicy"
  ADD CONSTRAINT "LeavePolicy_monthly_divisible"
  CHECK ("accrual" <> 'MONTHLY' OR "allowance" % 12 = 0);

ALTER TABLE "orgapp"."LeavePolicy"
  ADD CONSTRAINT "LeavePolicy_cap_nonnegative"
  CHECK ("cap" IS NULL OR "cap" >= 0);
