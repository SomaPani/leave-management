-- AlterTable
ALTER TABLE "LeaveRequest" ADD COLUMN     "endTime" INTEGER,
ADD COLUMN     "startTime" INTEGER;

-- A half-timed row has no meaning: a reader would have to guess whether the
-- missing end is midnight or an absent time. Pairing them in the database
-- rather than only in the service means no import, no backfill and no future
-- writer can produce one.
ALTER TABLE "orgapp"."LeaveRequest"
  ADD CONSTRAINT "LeaveRequest_times_paired"
  CHECK (("startTime" IS NULL) = ("endTime" IS NULL));

-- Ordering and range. The four-hour cap is deliberately NOT here: it is a
-- policy about short leave that may reasonably change, and a CHECK would
-- make changing it a migration.
ALTER TABLE "orgapp"."LeaveRequest"
  ADD CONSTRAINT "LeaveRequest_times_ordered"
  CHECK (
    "startTime" IS NULL
    OR ("startTime" >= 0 AND "endTime" <= 1440 AND "startTime" < "endTime")
  );
