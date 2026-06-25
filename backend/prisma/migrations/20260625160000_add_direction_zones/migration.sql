-- Per-lane direction zones: [{polygon:[...], arrow:[ax1,ay1,ax2,ay2]}] normalised.
-- Fixed heading prior + same-zone association; also acts as the ROI when set.
ALTER TABLE "Camera" ADD COLUMN "directionZones" JSONB;
