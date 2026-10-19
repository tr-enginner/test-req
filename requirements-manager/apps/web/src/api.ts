export class ApiError extends Error {
    constructor(message: string, public readonly status: number, public readonly details?: Record<string, unknown>) {
        super(message);
        this.name = "ApiError"
    }
}

async function parseError(response: Response) {
    const details = await response.json().catch(() => null);
    return new ApiError(details?.message || response.statusText, response.status, details || undefined)
}

type SessionExpiredListener = () => void;

const sessionExpiredListeners = new Set<SessionExpiredListener>();
let sessionExpiredNotified = false;

function requestPath(input: RequestInfo | URL) {
    const value = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    try {
        return new URL(value, "http://localhost").pathname
    } catch {
        return value
    }
}

function isAuthenticationRequest(input: RequestInfo | URL) {
    return /^\/(?:api\/)?auth(?:\/|$)/.test(requestPath(input))
}

function notifySessionExpired() {
    if (sessionExpiredNotified) return;
    sessionExpiredNotified = true;
    for (const listener of sessionExpiredListeners) listener()
}

export function subscribeToSessionExpired(listener: SessionExpiredListener) {
    sessionExpiredListeners.add(listener);
    return () => {
        sessionExpiredListeners.delete(listener)
    }
}

export function resetSessionExpiredNotification() {
    sessionExpiredNotified = false
}

export async function authenticatedFetch(input: RequestInfo | URL, init: RequestInit = {}) {
    const response = await fetch(input, {...init, credentials: "include"});
    if (response.status === 401 && !isAuthenticationRequest(input)) notifySessionExpired();
    return response
}

export async function api<T>(url: string, init: RequestInit = {}): Promise<T> {
    const hasJsonBody = init.body !== undefined && !(init.body instanceof FormData);
    const response = await authenticatedFetch(`/api${url}`, {
        ...init,
        headers: {...(hasJsonBody ? {"Content-Type": "application/json"} : {}), ...init.headers}
    });
    if (!response.ok) throw await parseError(response);
    return response.json()
}

export async function downloadApi(url: string) {
    const response = await authenticatedFetch(`/api${url}`);
    if (!response.ok) throw await parseError(response);
    const disposition = response.headers.get("Content-Disposition") || "";
    const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
    const plain = disposition.match(/filename="([^"]+)"/i)?.[1];
    return {blob: await response.blob(), filename: encoded ? decodeURIComponent(encoded) : plain || "download.docx"}
}

export function saveDownload(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob), anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0)
}

export type Project = {
    id: string;
    name: string;
    createdAt: string;
    status: string;
    currentActivity?: CurrentActivity | null;
    reviewSummary?: ReviewSummary | null;
    missingArtifacts?: string[];
    runs: Phase2Run[];
    documents: { id: string; name: string; parseStatus?: string; parseError?: string }[]
};
export type CurrentUser = { id: string; username: string; role: "ADMIN" | "REVIEWER" | "VIEWER" };

export type DebugTreeNode = {
    name: string;
    path: string;
    type: "directory" | "file";
    size?: number;
    modifiedAt?: string;
    version?: string;
    children?: DebugTreeNode[]
};
export type ReviewSummary = {
    total: number;
    reviewed: number;
    pending: number;
    progress: number;
    status: "NOT_STARTED" | "IN_PROGRESS" | "COMPLETED"
};
export type CurrentActivity = {
    type: "GENERATION" | "PUBLISH";
    status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED";
    stage?: string;
    progress: number;
    startedAt?: string;
    finishedAt?: string
};

export type DebugFile = {
    editable: boolean;
    deletable: boolean;
    path: string;
    size: number;
    modifiedAt: string;
    version: string;
    kind: "text" | "image" | "binary";
    content?: string;
    contentBase64?: string;
    mimeType?: string;
    runStatus?: string | null
};

export type DocumentNode = {
    id: string;
    documentId: string;
    sourceRef: string;
    number?: string;
    title: string;
    text?: string;
    level: number;
    parentId?: string | null;
    orderIndex: number;
    paragraphIndex?: number;
    paraId?: string;
    headingPath?: string[]
};
export type RequirementNode = {
    id: string;
    businessId: string;
    entityUid?: string;
    nodeType: string;
    number?: string;
    title: string;
    level: number;
    parentId?: string | null;
    orderIndex: number;
    artifact: string;
    content?: Record<string, unknown>;
    sourceRefs?: string[]
};
export type TraceLink = {
    id: string;
    sourceNodeId: string;
    targetNodeId: string;
    direct?: boolean;
    sourceNode: DocumentNode & { document?: { id: string; name: string } };
    targetNode: RequirementNode
};
export type Phase2Block = {
    type: "heading" | "paragraph" | "list" | "table" | "table_selector" | "requirement_actions" | "reference_list" | "error";
    text?: string;
    level?: number;
    openQuestions?: string[];
    openQuestionGroups?: {title: string; questions: string[]}[];
    anchorId?: string;
    evaluable?: boolean;
    businessId?: string;
    sourceRefs?: string[];
    items?: string[];
    caption?: string;
    captionParts?: Phase2TextPart[];
    columns?: string[];
    rows?: string[][];
    cells?: { text: string; colSpan?: number; rowSpan?: number }[][];
    rowAnchorIds?: (string | undefined)[];
    parts?: Phase2TextPart[];
    itemBindings?: (Phase2EditBinding | undefined)[];
    cellBindings?: (Phase2EditBinding | undefined)[][];
    headerBindings?: (Phase2EditBinding | undefined)[];
    tableBinding?: Phase2TableBinding;
    selectionBinding?: Phase2EditBinding;
    selectionRole?: "概述" | "输入流" | "输出流";
    selectionEditKey?: string;
    sourceTableId?: string;
    rowSourceBindings?: (Phase2EditBinding | undefined)[];
    sourceBinding?: Phase2EditBinding;
    requirementBinding?: Phase2RequirementBinding;
    requirementKey?: string;
    rowRequirementKeys?: string[]
    references?: {document_id: string; document_title: string; management: "fixed" | "automatic" | "project"}[];
    referenceBinding?: {container_key: string; node_id?: string}
};
export type Phase2EditBinding = {edit_key: string; node_id: string; field?: string; kind: "text" | "multiline" | "list_item" | "table_cell" | "table_header" | "source_refs" | "table_selection" | "requirement_id_suffix"; value: string | string[]; options?: string[]};
export type Phase2RequirementBinding = {container_key: string; allow_add: boolean; prefix: string; mode: "functional" | "non_functional" | "interface"; interface_label?: string; related_description_options?: string[]};
export type Phase2TableBinding = {container_key: string; allow_add_row: boolean; allow_delete_row: boolean; allow_add_column: boolean; allow_delete_column: boolean; row_keys: string[]; column_keys: string[]; new_row_columns?: string[]};
export type Phase2AddedColumnDraft = {title: string; values: string[]};
export type Phase2TableOperation = {container_key: string; operation: "add_row" | "delete_row" | "add_column" | "delete_column"; row_key?: string; column_key?: string; initial_value?: string | string[] | Record<string, string> | Phase2AddedColumnDraft; draft_key?: string};
export type Phase2RequirementOperation = {container_key: string; operation: "add_requirement" | "delete_requirement"; requirement_key?: string; requested_suffix?: string; initial_value?: {content?: string; description?: string; related_description?: string; source_refs: string[]}; draft_key?: string};
export type Phase2ReferenceOperation = {container_key: string; operation: "add_reference" | "update_reference" | "delete_reference"; reference_key?: string; initial_value?: {document_id: string; document_title: string}; draft_key?: string};
export type Phase2TextPart = {text: string; editable?: false} | {text: string; editable: true; binding: Phase2EditBinding};
export type Phase2Chapter = {
    artifact: string;
    number: string;
    title: string;
    rootNodeId?: string;
    blocks: Phase2Block[];
    warnings?: string[];
    skippedCount?: number
};
export type ReviewData = {
    project: {id: string; name: string; status?: string};
    documents: ({ id: string; name: string; parseStatus: string; parseError?: string; nodes: DocumentNode[] })[];
    requirements: RequirementNode[];
    links: TraceLink[];
    phase2Document: { chapters: Phase2Chapter[] };
    generation?: {runId: string; status: string; currentStage?: string; completedStages?: string[]; progress: number} | null
};
export type ReviewScores = { correctness: number; coverage: number; testability: number };
export type ReviewRecord = {
    id: string;
    nodeId: string;
    version: number;
    scores: ReviewScores & { completeness?: number };
    weightedScore: number;
    grade: string;
    comment?: string;
    createdAt: string
};
export type EditTimeSegmentInput = {id: string; startedAt: string; durationMs: number};
export type EditTimeSummary = {myDurationMs: number; projectDurationMs: number;
    users: {userId: string; username: string; durationMs: number}[]};
export type MissingReview = { id: string; number: string; title: string };

export type RunEvent = { id: string; type: string; payload: Record<string, unknown>; createdAt: string };
export type RunEventHistory = {items: RunEvent[]; nextCursor?: string; hasMore: boolean};
export type TokenUsage = {input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number;
    total: number; complete: boolean};
export type Phase2Run = {
    elapsedMs?: number;
    id: string;
    status: string;
    autoRetry: boolean;
    attemptCount: number;
    progress: number;
    currentStage?: string;
    completedStages?: string[];
    errorMessage?: string;
    startedAt?: string;
    finishedAt?: string;
    tokenUsage?: TokenUsage | null;
    usageUpdatedAt?: string | null;
    events?: RunEvent[]
};
export type EditorField = {key: string; label: string; type: "text" | "json" | "source_refs"; required?: boolean};
export type SourceRefOption = {value: string; role: string; document_name: string; number: string; title: string; path_titles?: string[]};
export type SourceTableOption = {table_id: string; title: string; source_ref: string; document_name: string; section_number: string; section_title: string; section_path_titles?: string[]; table_html: string; selected_location?: string; order: number};
export type Phase2EditorDescriptor = {artifact: string; business_id?: string; revision: string;
    operation_capabilities: {update: boolean; add: boolean; delete: boolean}; form_schema: EditorField[];
    value: Record<string, unknown>; available_source_refs: SourceRefOption[];
    editable?: boolean; disabled_reason?: string; warnings?: string[]; skipped_count?: number};
export type Phase2EditRun = {id: string; status: string; progress: number; currentStage?: string; errorMessage?: string;
    savedAt?: string; savedRevision?: string; publishedAt?: string; publicationStatus?: "QUEUED" | "BUILDING" | "PUBLISHED" | "FAILED";
    warnings?: string[]; skippedCount?: number; draftStatus?: "NONE" | "SAVED" | "PUBLISH_FAILED";
    stageTimings?: Record<string, {startedAt: string; finishedAt: string; durationMs: number}>; startedAt?: string; finishedAt?: string};
export type Phase2InlineDescriptor = {revision: string; artifact_revisions?: Record<string, string>; available_source_refs: SourceRefOption[]; available_tables: SourceTableOption[]; warnings?: string[]; skipped_count?: number};
export type RequirementRevision = {id: string; sequence: number; versionLabel: string;
    versionName?: string;
    kind: "GENERATED_BASELINE" | "MIGRATED_BASELINE" | "PUBLISHED"; parentRevisionId?: string; baselineRevisionId?: string;
    editRunId?: string; changeSummary?: Record<string, number>; createdAt: string; publishedAt?: string};
export type RequirementChange = {entityUid: string; type: "ADDED" | "DELETED" | "MODIFIED" | "MOVED" | "RENUMBERED" | "TRACE_CHANGED" | "TABLE_CHANGED";
    before?: RequirementNode; after?: RequirementNode; fields?: {field: string; before: unknown; after: unknown}[];
    chapterNumber?: string; parentAnchor?: string; beforeAnchorKey?: string; afterAnchorKey?: string;
    beforeLocation?: {artifact: string; number?: string; title?: string; parentId?: string}; afterLocation?: {artifact: string; number?: string; title?: string; parentId?: string};
    changedFields?: string[]; textSegments?: {type: "EQUAL" | "DELETE" | "INSERT"; text: string}[];
    beforeSnapshot?: RequirementNode; afterSnapshot?: RequirementNode; beforeText?: string; afterText?: string;
    leafChanges?: {path: string; before: unknown; after: unknown}[];
    tableChanges?: {path: string; addedColumns: {index: number; value: unknown}[]; deletedColumns: {index: number; value: unknown}[];
        addedRows: {index: number; value: unknown}[]; deletedRows: {index: number; value: unknown}[]}[]};
export type RequirementDiffAnnotation = {entityUid: string; nodeId?: string; businessId?: string; type: RequirementChange["type"];
    nodeType?: string; side: "before" | "after"; segments?: RequirementChange["textSegments"]; changedFields?: string[];
    changedValues?: string[]; leafChanges?: RequirementChange["leafChanges"]; tableChanges?: RequirementChange["tableChanges"];
    sourceRefs?: string[]; counterpartSourceRefs?: string[]};
export type RequirementDiff = {from: RequirementRevision; to: RequirementRevision; algorithmVersion: string;
    summary: Record<string, number>; changes: RequirementChange[]; warnings: string[]};
