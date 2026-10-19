export const REQUIREMENT_SCROLL_OFFSET = 20;

export function requirementScrollTop({
    currentScrollTop,
    containerTop,
    targetTop,
    scrollHeight,
    clientHeight,
    offset = REQUIREMENT_SCROLL_OFFSET
}: {
    currentScrollTop: number;
    containerTop: number;
    targetTop: number;
    scrollHeight: number;
    clientHeight: number;
    offset?: number;
}) {
    const desired = currentScrollTop + targetTop - containerTop - offset;
    return Math.min(Math.max(0, desired), Math.max(0, scrollHeight - clientHeight))
}
