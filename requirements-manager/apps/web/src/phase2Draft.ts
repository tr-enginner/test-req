import type {Phase2ReferenceOperation, Phase2RequirementOperation, Phase2TableOperation} from "./api";

export type Phase2LocalDraft = {
    version: 1;
    projectId: string;
    userId: string;
    editorDrafts: Record<string, unknown>;
    tableOperations: Phase2TableOperation[];
    requirementOperations: Phase2RequirementOperation[];
    referenceOperations: Phase2ReferenceOperation[];
    expectedRevision?: string;
    expectedArtifactRevisions?: Record<string, string>;
    editRunId?: string;
};

export const phase2DraftKey = (projectId: string, userId: string) => `matrix-phase2-draft:${projectId}:${userId}`;

export function readPhase2Draft(projectId: string, userId: string): Phase2LocalDraft | undefined {
    const key = phase2DraftKey(projectId, userId);
    try {
        const value = JSON.parse(localStorage.getItem(key) || "null") as Partial<Phase2LocalDraft> | null;
        if (!value || value.version !== 1 || value.projectId !== projectId || value.userId !== userId
            || !value.editorDrafts || typeof value.editorDrafts !== "object" || Array.isArray(value.editorDrafts)
            || !Array.isArray(value.tableOperations) || !Array.isArray(value.requirementOperations)
            || value.referenceOperations !== undefined && !Array.isArray(value.referenceOperations)) {
            if (value) localStorage.removeItem(key);
            return undefined
        }
        return {...value, referenceOperations: value.referenceOperations || []} as Phase2LocalDraft
    } catch {
        localStorage.removeItem(key);
        return undefined
    }
}

export function writePhase2Draft(value: Phase2LocalDraft) {
    localStorage.setItem(phase2DraftKey(value.projectId, value.userId), JSON.stringify(value))
}

export function removePhase2Draft(projectId: string, userId: string) {
    localStorage.removeItem(phase2DraftKey(projectId, userId))
}
