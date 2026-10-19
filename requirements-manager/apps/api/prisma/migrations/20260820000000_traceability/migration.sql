ALTER TABLE "Document" DROP COLUMN "pdfObjectKey",
ADD COLUMN "fileHash" TEXT,
ADD COLUMN "parseStatus" TEXT NOT NULL DEFAULT 'PENDING',
ADD COLUMN "parseError" TEXT;

CREATE TABLE "DocumentNode"
(
    "id"             TEXT    NOT NULL,
    "documentId"     TEXT    NOT NULL,
    "sourceRef"      TEXT    NOT NULL,
    "nodeType"       TEXT    NOT NULL DEFAULT 'heading',
    "number"         TEXT,
    "title"          TEXT    NOT NULL,
    "text"           TEXT,
    "level"          INTEGER NOT NULL,
    "parentId"       TEXT,
    "orderIndex"     INTEGER NOT NULL,
    "paragraphIndex" INTEGER,
    "paraId"         TEXT,
    "textHash"       TEXT,
    "headingPath"    JSONB,
    CONSTRAINT "DocumentNode_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "TestRequirementNode"
(
    "id"         TEXT    NOT NULL,
    "projectId"  TEXT    NOT NULL,
    "businessId" TEXT    NOT NULL,
    "nodeType"   TEXT    NOT NULL,
    "number"     TEXT,
    "title"      TEXT    NOT NULL,
    "level"      INTEGER NOT NULL,
    "parentId"   TEXT,
    "orderIndex" INTEGER NOT NULL,
    "artifact"   TEXT    NOT NULL,
    "content"    JSONB,
    "sourceRefs" JSONB,
    CONSTRAINT "TestRequirementNode_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "TraceLink"
(
    "id"           TEXT NOT NULL,
    "projectId"    TEXT NOT NULL,
    "sourceNodeId" TEXT NOT NULL,
    "targetNodeId" TEXT NOT NULL,
    "relationType" TEXT NOT NULL DEFAULT 'generated',
    "source"       TEXT NOT NULL DEFAULT 'phase2-test-traceability.json',
    "confidence"   DOUBLE PRECISION,
    CONSTRAINT "TraceLink_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "DocumentNode_documentId_sourceRef_key" ON "DocumentNode" ("documentId", "sourceRef");
CREATE INDEX "DocumentNode_documentId_parentId_orderIndex_idx" ON "DocumentNode" ("documentId", "parentId", "orderIndex");
CREATE UNIQUE INDEX "TestRequirementNode_projectId_businessId_key" ON "TestRequirementNode" ("projectId", "businessId");
CREATE INDEX "TestRequirementNode_projectId_parentId_orderIndex_idx" ON "TestRequirementNode" ("projectId", "parentId", "orderIndex");
CREATE UNIQUE INDEX "TraceLink_sourceNodeId_targetNodeId_key" ON "TraceLink" ("sourceNodeId", "targetNodeId");
CREATE INDEX "TraceLink_projectId_sourceNodeId_idx" ON "TraceLink" ("projectId", "sourceNodeId");
CREATE INDEX "TraceLink_projectId_targetNodeId_idx" ON "TraceLink" ("projectId", "targetNodeId");
ALTER TABLE "DocumentNode"
    ADD CONSTRAINT "DocumentNode_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document" ("id") ON DELETE CASCADE;
ALTER TABLE "DocumentNode"
    ADD CONSTRAINT "DocumentNode_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "DocumentNode" ("id") ON DELETE SET NULL;
ALTER TABLE "TestRequirementNode"
    ADD CONSTRAINT "TestRequirementNode_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE;
ALTER TABLE "TestRequirementNode"
    ADD CONSTRAINT "TestRequirementNode_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "TestRequirementNode" ("id") ON DELETE SET NULL;
ALTER TABLE "TraceLink"
    ADD CONSTRAINT "TraceLink_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE;
ALTER TABLE "TraceLink"
    ADD CONSTRAINT "TraceLink_sourceNodeId_fkey" FOREIGN KEY ("sourceNodeId") REFERENCES "DocumentNode" ("id") ON DELETE CASCADE;
ALTER TABLE "TraceLink"
    ADD CONSTRAINT "TraceLink_targetNodeId_fkey" FOREIGN KEY ("targetNodeId") REFERENCES "TestRequirementNode" ("id") ON DELETE CASCADE;
