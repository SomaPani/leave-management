-- CreateEnum
CREATE TYPE "ScoreStatus" AS ENUM ('SCORED', 'NOT_SCORED');

-- CreateTable
CREATE TABLE "ScoreDay" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "status" "ScoreStatus" NOT NULL,
    "reason" TEXT,
    "attendance" TEXT NOT NULL,
    "checkinPts" DOUBLE PRECISION,
    "pickedPts" DOUBLE PRECISION,
    "descriptionPts" DOUBLE PRECISION,
    "commitPts" DOUBLE PRECISION,
    "commentPts" DOUBLE PRECISION,
    "deliveryPts" DOUBLE PRECISION,
    "coordinationPts" DOUBLE PRECISION,
    "process" DOUBLE PRECISION,
    "delivery" DOUBLE PRECISION,
    "total" DOUBLE PRECISION,
    "band" TEXT,
    "tasksPicked" INTEGER,
    "tasksDone" INTEGER,
    "tasksCredit" DOUBLE PRECISION,
    "volumeFactor" DOUBLE PRECISION,
    "pickedTasks" TEXT[],
    "flags" TEXT[],
    "computedAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScoreDay_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ScoreDay_organizationId_date_idx" ON "ScoreDay"("organizationId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "ScoreDay_userId_date_key" ON "ScoreDay"("userId", "date");

-- AddForeignKey
ALTER TABLE "ScoreDay" ADD CONSTRAINT "ScoreDay_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScoreDay" ADD CONSTRAINT "ScoreDay_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
