-- CreateEnum
CREATE TYPE "Direction" AS ENUM ('AB', 'BA');

-- CreateTable
CREATE TABLE "Camera" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "location" VARCHAR(255) NOT NULL,
    "streamUrl" VARCHAR(1024) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "maxSpeedKmh" INTEGER,
    "homographyMatrix" DOUBLE PRECISION[],
    "calibrationPoints" JSONB,
    "countingLineA" DOUBLE PRECISION NOT NULL DEFAULT 0.4,
    "countingLineB" DOUBLE PRECISION NOT NULL DEFAULT 0.6,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Camera_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrafficEvent" (
    "id" TEXT NOT NULL,
    "cameraId" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "direction" "Direction" NOT NULL,
    "vehicleClass" VARCHAR(50) NOT NULL,
    "speedKmh" DOUBLE PRECISION,
    "isSpeeder" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "TrafficEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailyCount" (
    "id" TEXT NOT NULL,
    "cameraId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "directionAB" INTEGER NOT NULL DEFAULT 0,
    "directionBA" INTEGER NOT NULL DEFAULT 0,
    "speeders" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "DailyCount_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TrafficEvent_cameraId_timestamp_idx" ON "TrafficEvent"("cameraId", "timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "DailyCount_cameraId_date_key" ON "DailyCount"("cameraId", "date");

-- AddForeignKey
ALTER TABLE "TrafficEvent" ADD CONSTRAINT "TrafficEvent_cameraId_fkey" FOREIGN KEY ("cameraId") REFERENCES "Camera"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyCount" ADD CONSTRAINT "DailyCount_cameraId_fkey" FOREIGN KEY ("cameraId") REFERENCES "Camera"("id") ON DELETE CASCADE ON UPDATE CASCADE;
