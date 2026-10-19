CREATE TYPE "RequirementRevisionKind" AS ENUM ('GENERATED_BASELINE', 'MIGRATED_BASELINE', 'PUBLISHED');
CREATE TYPE "RequirementRevisionStatus" AS ENUM ('BUILDING', 'PUBLISHED', 'FAILED', 'CORRUPTED');

ALTER TABLE "TestRequirementNode" ADD COLUMN "entityUid" TEXT;
UPDATE "TestRequirementNode" SET "entityUid" = id WHERE "entityUid" IS NULL;
ALTER TABLE "TestRequirementNode" ALTER COLUMN "entityUid" SET NOT NULL;
CREATE INDEX "TestRequirementNode_projectId_entityUid_idx" ON "TestRequirementNode"("projectId", "entityUid");

CREATE TABLE "RequirementRevision" (
  "id" TEXT NOT NULL, "projectId" TEXT NOT NULL, "sequence" INTEGER NOT NULL,
  "versionLabel" TEXT NOT NULL, "kind" "RequirementRevisionKind" NOT NULL,
  "status" "RequirementRevisionStatus" NOT NULL DEFAULT 'BUILDING',
  "parentRevisionId" TEXT, "baselineRevisionId" TEXT, "editRunId" TEXT,
  "storagePath" TEXT NOT NULL, "manifestHash" TEXT NOT NULL,
  "sourceRevision" TEXT, "resultRevision" TEXT, "changeSummary" JSONB,
  "createdById" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "publishedAt" TIMESTAMP(3), CONSTRAINT "RequirementRevision_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "RequirementRevision_projectId_sequence_key" ON "RequirementRevision"("projectId", "sequence");
CREATE UNIQUE INDEX "RequirementRevision_editRunId_key" ON "RequirementRevision"("editRunId");
CREATE INDEX "RequirementRevision_projectId_status_idx" ON "RequirementRevision"("projectId", "status");

CREATE TABLE "RequirementChangeSet" (
  "id" TEXT NOT NULL, "projectId" TEXT NOT NULL, "fromRevisionId" TEXT NOT NULL,
  "toRevisionId" TEXT NOT NULL, "algorithmVersion" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'READY', "summary" JSONB NOT NULL,
  "changes" JSONB NOT NULL, "warnings" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RequirementChangeSet_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "RequirementChangeSet_fromRevisionId_toRevisionId_algorithmVersion_key" ON "RequirementChangeSet"("fromRevisionId", "toRevisionId", "algorithmVersion");
CREATE INDEX "RequirementChangeSet_projectId_createdAt_idx" ON "RequirementChangeSet"("projectId", "createdAt");

ALTER TABLE "Review" ADD COLUMN "entityUid" TEXT, ADD COLUMN "revisionId" TEXT, ADD COLUMN "invalidatedAt" TIMESTAMP(3), ADD COLUMN "invalidatedByRevisionId" TEXT;
UPDATE "Review" r SET "entityUid"=n."entityUid" FROM "TestRequirementNode" n WHERE r."nodeId"=n.id AND r."projectId"=n."projectId";
ALTER TABLE "RequirementRevision" ADD CONSTRAINT "RequirementRevision_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RequirementRevision" ADD CONSTRAINT "RequirementRevision_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RequirementRevision" ADD CONSTRAINT "RequirementRevision_editRunId_fkey" FOREIGN KEY ("editRunId") REFERENCES "Phase2EditRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RequirementRevision" ADD CONSTRAINT "RequirementRevision_parentRevisionId_fkey" FOREIGN KEY ("parentRevisionId") REFERENCES "RequirementRevision"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RequirementRevision" ADD CONSTRAINT "RequirementRevision_baselineRevisionId_fkey" FOREIGN KEY ("baselineRevisionId") REFERENCES "RequirementRevision"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RequirementChangeSet" ADD CONSTRAINT "RequirementChangeSet_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RequirementChangeSet" ADD CONSTRAINT "RequirementChangeSet_fromRevisionId_fkey" FOREIGN KEY ("fromRevisionId") REFERENCES "RequirementRevision"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RequirementChangeSet" ADD CONSTRAINT "RequirementChangeSet_toRevisionId_fkey" FOREIGN KEY ("toRevisionId") REFERENCES "RequirementRevision"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Review" ADD CONSTRAINT "Review_revisionId_fkey" FOREIGN KEY ("revisionId") REFERENCES "RequirementRevision"("id") ON DELETE SET NULL ON UPDATE CASCADE;
