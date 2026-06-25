-- Fixed kiosk slot a camera is shown on (FLASH-PI-01/02/03). Nullable + unique:
-- Postgres allows multiple NULLs, so at most one camera per slot.
ALTER TABLE "Camera" ADD COLUMN "displaySlot" TEXT;
CREATE UNIQUE INDEX "Camera_displaySlot_key" ON "Camera"("displaySlot");
