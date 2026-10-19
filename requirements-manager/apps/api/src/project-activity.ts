export type ActivityStatus = "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED";

type ActivityCandidate = {
    status: ActivityStatus;
    currentStage?: string | null;
    progress: number;
    startedAt?: Date | null;
    finishedAt?: Date | null;
    createdAt?: Date | null
};

export type CurrentActivity = {
    type: "GENERATION" | "PUBLISH";
    status: ActivityStatus;
    stage?: string;
    progress: number;
    startedAt?: Date;
    finishedAt?: Date
};

const active = (candidate?: ActivityCandidate) => candidate?.status === "QUEUED" || candidate?.status === "RUNNING";
const timestamp = (candidate?: ActivityCandidate) =>
    candidate?.finishedAt?.getTime() ?? candidate?.startedAt?.getTime() ?? candidate?.createdAt?.getTime() ?? 0;

function activity(type: CurrentActivity["type"], candidate?: ActivityCandidate): CurrentActivity | null {
    if (!candidate) return null;
    return {
        type,
        status: candidate.status,
        ...(candidate.currentStage ? {stage: candidate.currentStage} : {}),
        progress: candidate.progress,
        ...(candidate.startedAt ? {startedAt: candidate.startedAt} : {}),
        ...(candidate.finishedAt ? {finishedAt: candidate.finishedAt} : {})
    }
}

export function selectCurrentActivity(projectStatus: string, generation?: ActivityCandidate, publish?: ActivityCandidate) {
    // Active publication wins if corrupt data contains two simultaneous activities.
    if (active(publish)) return activity("PUBLISH", publish);
    if (active(generation)) return activity("GENERATION", generation);
    if (projectStatus === "REBUILDING" && publish) return activity("PUBLISH", publish);
    if (projectStatus === "GENERATING" && generation) return activity("GENERATION", generation);
    return timestamp(publish) > timestamp(generation)
        ? activity("PUBLISH", publish)
        : activity("GENERATION", generation)
}
