-- Team profile fields and org-scoped regions.
--
-- Every object is schema-qualified rather than relying on the `schema=orgapp`
-- parameter to set the search path — same rule as the baseline migration.
-- `prisma migrate diff` generates these names bare, so they are qualified by
-- hand; a bare `CREATE TABLE "Region"` would land in `public` on a fresh
-- database.

-- CreateEnum
CREATE TYPE "orgapp"."WorkMode" AS ENUM ('WFO', 'WFH');

-- CreateEnum
CREATE TYPE "orgapp"."EmploymentStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- AlterTable
ALTER TABLE "orgapp"."User" ADD COLUMN     "address" TEXT,
ADD COLUMN     "emergencyName" TEXT,
ADD COLUMN     "emergencyPhone" TEXT,
ADD COLUMN     "empId" TEXT,
ADD COLUMN     "joinedOn" TIMESTAMP(3),
ADD COLUMN     "managerId" TEXT,
ADD COLUMN     "personalEmail" TEXT,
ADD COLUMN     "phone" TEXT,
ADD COLUMN     "regionId" TEXT,
ADD COLUMN     "status" "orgapp"."EmploymentStatus" NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN     "title" TEXT,
ADD COLUMN     "workMode" "orgapp"."WorkMode";

-- CreateTable
CREATE TABLE "orgapp"."Region" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Region_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Region_organizationId_idx" ON "orgapp"."Region"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "Region_organizationId_name_key" ON "orgapp"."Region"("organizationId", "name");

-- CreateIndex
CREATE INDEX "User_regionId_idx" ON "orgapp"."User"("regionId");

-- CreateIndex
-- Employee ids are unique per organization, not globally. Postgres treats NULLs
-- as distinct, so the members without one do not collide.
CREATE UNIQUE INDEX "User_organizationId_empId_key" ON "orgapp"."User"("organizationId", "empId");

-- AddForeignKey
ALTER TABLE "orgapp"."Region" ADD CONSTRAINT "Region_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "orgapp"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orgapp"."User" ADD CONSTRAINT "User_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "orgapp"."Region"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orgapp"."User" ADD CONSTRAINT "User_managerId_fkey" FOREIGN KEY ("managerId") REFERENCES "orgapp"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
