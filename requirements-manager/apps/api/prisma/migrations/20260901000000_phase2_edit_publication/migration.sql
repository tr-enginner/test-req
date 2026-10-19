ALTER TABLE "Phase2EditRun" ADD COLUMN "savedAt" TIMESTAMP(3);
ALTER TABLE "Phase2EditRun" ADD COLUMN "savedRevision" TEXT;
ALTER TABLE "Phase2EditRun" ADD COLUMN "publishedAt" TIMESTAMP(3);
ALTER TABLE "Phase2EditRun" ADD COLUMN "stageTimings" JSONB;
ALTER TABLE "Phase2EditRun" ADD COLUMN "applyResult" JSONB;
