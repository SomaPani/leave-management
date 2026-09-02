-- `Attendance.markedById` is attribution, not ownership.
--
-- It landed as NOT NULL with ON DELETE RESTRICT, which made deleting an admin
-- who had ever marked a day fail on a foreign key — /api/admins/[id] hard
-- deletes, so that is a reachable 500. Cascading instead would be worse: it
-- would destroy the team's attendance record along with the departing admin.
--
-- SET NULL keeps the rows and drops only the name. Null therefore means "the
-- admin who marked this is gone", never "nobody marked it" — the service always
-- sets it. AttendanceEvent.actorId still carries the original id, because that
-- table deliberately holds no foreign key to User.
--
-- Schema-qualified by hand, as ever: `prisma migrate diff` emits bare names.

-- DropForeignKey
ALTER TABLE "orgapp"."Attendance" DROP CONSTRAINT "Attendance_markedById_fkey";

-- AlterTable
ALTER TABLE "orgapp"."Attendance" ALTER COLUMN "markedById" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "orgapp"."Attendance" ADD CONSTRAINT "Attendance_markedById_fkey" FOREIGN KEY ("markedById") REFERENCES "orgapp"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
