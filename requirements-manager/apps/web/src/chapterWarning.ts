import type {Phase2Chapter} from "./api";

export type ChapterWarningPresentation = {
    warnings: string[];
    skippedCount: number;
    openQuestions: string[];
    openQuestionGroups: {title: string; questions: string[]}[]
};

export function chapterWarningForBlock(chapter: Phase2Chapter, blockIndex: number): ChapterWarningPresentation | undefined {
    const firstHeading = chapter.blocks.findIndex(block => block.type === "heading");
    const warnings = firstHeading === blockIndex ? (chapter.warnings || []).map(item => String(item).trim()).filter(Boolean) : [];
    const openQuestions = (chapter.blocks[blockIndex]?.openQuestions || []).map(item => String(item).trim()).filter(Boolean);
    const openQuestionGroups = (chapter.blocks[blockIndex]?.openQuestionGroups || []).map(group => ({
        title: String(group.title).trim(), questions: [...new Set((group.questions || []).map(item => String(item).trim()).filter(Boolean))]
    })).filter(group => group.title && group.questions.length);
    if (!warnings.length && !openQuestions.length && !openQuestionGroups.length) return undefined;
    const rawCount = Number(chapter.skippedCount);
    return {warnings, skippedCount: Number.isFinite(rawCount) && rawCount >= 0 ? Math.floor(rawCount) : 0,
        openQuestions: [...new Set(openQuestions)], openQuestionGroups}
}
