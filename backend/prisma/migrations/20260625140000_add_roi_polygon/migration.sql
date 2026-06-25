-- Road ROI mask: flattened normalised polygon [x1,y1,x2,y2,...]. Empty = no mask.
ALTER TABLE "Camera" ADD COLUMN "roiPolygon" DOUBLE PRECISION[] DEFAULT ARRAY[]::DOUBLE PRECISION[];
