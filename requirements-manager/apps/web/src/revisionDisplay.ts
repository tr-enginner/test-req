import type {RequirementRevision} from "./api";

export function revisionName(revision?: RequirementRevision) {
    return revision?.versionName
        || (revision?.kind === "MIGRATED_BASELINE" ? "迁移基线" : revision?.kind === "GENERATED_BASELINE" ? "初始基线" : "")
}

export function revisionTitle(revision?: RequirementRevision) {
    return revision ? `${revision.versionLabel}${revisionName(revision) ? ` · ${revisionName(revision)}` : ""}` : ""
}

export function revisionTime(revision?: RequirementRevision) {
    const value = revision?.publishedAt || revision?.createdAt;
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    const two = (part: number) => String(part).padStart(2, "0");
    return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`
}
