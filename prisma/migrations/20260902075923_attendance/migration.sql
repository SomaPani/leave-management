-- Attendance: one row per member per day, plus an append-only audit log.
--
-- Every object is schema-qualified rather than relying on the `schema=orgapp`
-- parameter to set the search path — same rule as the baseline and team
-- migrations. `prisma migrate diff` generates these names bare, so they are
-- qualified by hand; a bare `CREATE TABLE "Attendance"` would land in `public`
-- on a fresh database.

-- CreateEnum
CREATE TYPE "orgapp"."AttendanceStatus" AS ENUM ('PRESENT', 'WFH', 'ABSENT', 'LEAVE');

-- CreateEnum
CREATE TYPE "orgapp"."AttendanceModifier" AS ENUM ('HALF_DAY', 'SHORT_LEAVE');

-- CreateTable
CREATE TABLE "orgapp"."Attendance" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "status" "orgapp"."AttendanceStatus" NOT NULL,
    "modifier" "orgapp"."AttendanceModifier",
    "markedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Attendance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orgapp"."AttendanceEvent" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "fromStatus" "orgapp"."AttendanceStatus",
    "fromModifier" "orgapp"."AttendanceModifier",
    "toStatus" "orgapp"."AttendanceStatus",
    "toModifier" "orgapp"."AttendanceModifier",
    "actorId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AttendanceEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Attendance_organizationId_date_idx" ON "orgapp"."Attendance"("organizationId", "date");

-- CreateIndex
-- The natural key: one row per member per day.
CREATE UNIQUE INDEX "Attendance_userId_date_key" ON "orgapp"."Attendance"("userId", "date");

-- CreateIndex
CREATE INDEX "AttendanceEvent_organizationId_date_idx" ON "orgapp"."AttendanceEvent"("organizationId", "date");

-- CreateIndex
CREATE INDEX "AttendanceEvent_userId_date_idx" ON "orgapp"."AttendanceEvent"("userId", "date");

-- AddForeignKey
ALTER TABLE "orgapp"."Attendance" ADD CONSTRAINT "Attendance_userId_fkey" FOREIGN KEY ("userId") REFERENCES "orgapp"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orgapp"."Attendance" ADD CONSTRAINT "Attendance_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "orgapp"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orgapp"."Attendance" ADD CONSTRAINT "Attendance_markedById_fkey" FOREIGN KEY ("markedById") REFERENCES "orgapp"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orgapp"."AttendanceEvent" ADD CONSTRAINT "AttendanceEvent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "orgapp"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The combination rule, which Prisma's schema language cannot express:
-- "Half day" and "Short leave" are add-ons to a day that was partly worked. An
-- absence or a day of leave carries neither. Application code checks this too
-- (lib/attendance-service.ts), but this is what makes the invalid rows
-- genuinely unwritable rather than merely unwritten.
ALTER TABLE "orgapp"."Attendance"
  ADD CONSTRAINT "Attendance_modifier_requires_working_day"
  CHECK ("modifier" IS NULL OR "status" IN ('PRESENT', 'WFH'));
