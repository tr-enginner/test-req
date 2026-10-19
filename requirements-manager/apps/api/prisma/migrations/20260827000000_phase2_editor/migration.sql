ALTER TYPE "ProjectStatus" ADD VALUE IF NOT EXISTS 'REBUILDING';

CREATE TABLE "Phase2EditRun" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "targetBusinessId" TEXT,
  "operation" TEXT NOT NULL,
  "status" "RunStatus" NOT NULL DEFAULT 'QUEUED',
  "currentStage" TEXT,
  "progress" INTEGER NOT NULL DEFAULT 0,
  "expectedRevision" TEXT NOT NULL,
  "backupPath" TEXT,
  "errorMessage" TEXT,
  "request" JSONB NOT NULL,
  "startedAt" TIMESTAMP(3),
  "finishedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Phase2EditRun_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Phase2EditRun_projectId_status_idx" ON "Phase2EditRun"("projectId", "status");
ALTER TABLE "Phase2EditRun" ADD CONSTRAINT "Phase2EditRun_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Phase2EditRun" ADD CONSTRAINT "Phase2EditRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
