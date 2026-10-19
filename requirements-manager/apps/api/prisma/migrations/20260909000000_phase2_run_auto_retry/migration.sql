ALTER TABLE "Phase2Run"
ADD COLUMN "autoRetry" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "attemptCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "accumulatedElapsedMs" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN "attemptStartedAt" TIMESTAMP(3);

-- Preserve the elapsed time shown for existing runs. Active runs continue from
-- their original start; terminal runs are frozen at their old duration.
UPDATE "Phase2Run"
SET "attemptCount" = CASE WHEN "startedAt" IS NULL THEN 0 ELSE 1 END,
    "attemptStartedAt" = CASE WHEN status = 'RUNNING' THEN "startedAt" ELSE NULL END,
    "accumulatedElapsedMs" = CASE
      WHEN status IN ('SUCCEEDED', 'FAILED', 'CANCELLED') AND "startedAt" IS NOT NULL
        THEN GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (COALESCE("finishedAt", "startedAt") - "startedAt")) * 1000))::BIGINT
      ELSE 0
    END;
