CREATE TABLE "EditTimeSegment" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EditTimeSegment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EditTimeSegment_projectId_createdAt_idx" ON "EditTimeSegment"("projectId", "createdAt");
CREATE INDEX "EditTimeSegment_projectId_userId_idx" ON "EditTimeSegment"("projectId", "userId");

ALTER TABLE "EditTimeSegment" ADD CONSTRAINT "EditTimeSegment_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EditTimeSegment" ADD CONSTRAINT "EditTimeSegment_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

