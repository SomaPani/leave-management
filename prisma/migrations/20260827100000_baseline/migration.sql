-- Organization backbone schema.
--
-- Every object is schema-qualified rather than relying on the `schema=orgapp`
-- parameter to set the search path, so applying this file lands the tables in
-- `orgapp` regardless of how the connection was opened.

CREATE SCHEMA IF NOT EXISTS "orgapp";

-- CreateEnum
CREATE TYPE "orgapp"."Role" AS ENUM ('SUPERADMIN', 'ADMIN', 'MEMBER');

-- CreateTable
CREATE TABLE "orgapp"."Organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orgapp"."User" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "orgapp"."Role" NOT NULL,
    "organizationId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Organization_name_key" ON "orgapp"."Organization"("name");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "orgapp"."User"("email");

-- CreateIndex
CREATE INDEX "User_organizationId_idx" ON "orgapp"."User"("organizationId");

-- AddForeignKey
ALTER TABLE "orgapp"."User" ADD CONSTRAINT "User_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "orgapp"."Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;
