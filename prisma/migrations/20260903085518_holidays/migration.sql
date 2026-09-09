-- Public holidays, per organization and optionally per region.
--
-- Every object is schema-qualified rather than relying on the `schema=orgapp`
-- parameter to set the search path — same rule as every migration before it.

-- CreateTable
CREATE TABLE "orgapp"."Holiday" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "regionId" TEXT,
    "name" TEXT NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Holiday_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Holiday_organizationId_startDate_idx" ON "orgapp"."Holiday"("organizationId", "startDate");

-- CreateIndex
CREATE INDEX "Holiday_regionId_idx" ON "orgapp"."Holiday"("regionId");

-- AddForeignKey
ALTER TABLE "orgapp"."Holiday" ADD CONSTRAINT "Holiday_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "orgapp"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- Cascade, unlike User.regionId which is SetNull: a person outlives their
-- office, but "Pongal, in the Chennai region" has no meaning once Chennai is
-- gone — it would silently widen into an organization-wide holiday.
ALTER TABLE "orgapp"."Holiday" ADD CONSTRAINT "Holiday_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "orgapp"."Region"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The range is inclusive and ordered. Prisma's schema language cannot say so.
ALTER TABLE "orgapp"."Holiday"
  ADD CONSTRAINT "Holiday_range_ordered" CHECK ("endDate" >= "startDate");
