CREATE TYPE "Role" AS ENUM ('ADMIN','REVIEWER','VIEWER');
CREATE TYPE "ProjectStatus" AS ENUM ('IMPORTING','PENDING_GENERATION','INCOMPLETE_MATRIX','GENERATING','READY_FOR_REVIEW','FAILED');
CREATE TYPE "RunStatus" AS ENUM ('QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELLED');
CREATE TABLE "User"
(
    "id"           TEXT PRIMARY KEY,
    "username"     TEXT         NOT NULL UNIQUE,
    "passwordHash" TEXT         NOT NULL,
    "role"         "Role"       NOT NULL DEFAULT 'REVIEWER',
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "RefreshToken"
(
    "id"        TEXT PRIMARY KEY,
    "tokenHash" TEXT         NOT NULL UNIQUE,
    "userId"    TEXT         NOT NULL REFERENCES "User" ("id") ON DELETE CASCADE,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3)
);
CREATE TABLE "Project"
(
    "id"               TEXT PRIMARY KEY,
    "name"             TEXT            NOT NULL,
    "status"           "ProjectStatus" NOT NULL DEFAULT 'IMPORTING',
    "workspacePath"    TEXT            NOT NULL UNIQUE,
    "missingArtifacts" JSONB,
    "createdAt"        TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"        TIMESTAMP(3)    NOT NULL
);
CREATE TABLE "Document"
(
    "id"           TEXT PRIMARY KEY,
    "projectId"    TEXT NOT NULL REFERENCES "Project" ("id") ON DELETE CASCADE,
    "name"         TEXT NOT NULL,
    "objectKey"    TEXT NOT NULL,
    "pdfObjectKey" TEXT,
    "outline"      JSONB
);
CREATE TABLE "Phase2Run"
(
    "id"                TEXT PRIMARY KEY,
    "projectId"         TEXT        NOT NULL REFERENCES "Project" ("id") ON DELETE CASCADE,
    "status"            "RunStatus" NOT NULL DEFAULT 'QUEUED',
    "opencodeSessionId" TEXT,
    "currentStage"      TEXT,
    "progress"          INTEGER     NOT NULL DEFAULT 0,
    "completedStages"   JSONB,
    "errorMessage"      TEXT,
    "startedAt"         TIMESTAMP(3),
    "finishedAt"        TIMESTAMP(3)
);
CREATE INDEX "Phase2Run_projectId_status_idx" ON "Phase2Run" ("projectId", "status");
CREATE TABLE "RunEvent"
(
    "id"        BIGSERIAL PRIMARY KEY,
    "runId"     TEXT         NOT NULL REFERENCES "Phase2Run" ("id") ON DELETE CASCADE,
    "type"      TEXT         NOT NULL,
    "payload"   JSONB        NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "RunEvent_runId_id_idx" ON "RunEvent" ("runId", "id");
CREATE TABLE "Review"
(
    "id"            TEXT PRIMARY KEY,
    "projectId"     TEXT             NOT NULL REFERENCES "Project" ("id") ON DELETE CASCADE,
    "reviewerId"    TEXT             NOT NULL REFERENCES "User" ("id"),
    "nodeId"        TEXT             NOT NULL,
    "version"       INTEGER          NOT NULL DEFAULT 1,
    "scores"        JSONB            NOT NULL,
    "weightedScore" DOUBLE PRECISION NOT NULL,
    "grade"         TEXT             NOT NULL,
    "issues"        JSONB,
    "comment"       TEXT,
    "createdAt"     TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "Review_projectId_nodeId_version_key" ON "Review" ("projectId", "nodeId", "version");
CREATE TABLE "AuditLog"
(
    "id"           BIGSERIAL PRIMARY KEY,
    "userId"       TEXT,
    "action"       TEXT         NOT NULL,
    "resourceType" TEXT         NOT NULL,
    "resourceId"   TEXT,
    "detail"       JSONB,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
