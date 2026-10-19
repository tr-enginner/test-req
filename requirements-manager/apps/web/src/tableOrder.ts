export function uniqueTableIds(values: string[]) {
    return [...new Set(values)]
}

export function reorderTableIds(values: string[], activeId: string, overId: string) {
    const unique = uniqueTableIds(values);
    const oldIndex = unique.indexOf(activeId), newIndex = unique.indexOf(overId);
    if (oldIndex < 0 || newIndex < 0 || oldIndex === newIndex) return unique;
    const next = [...unique], [moved] = next.splice(oldIndex, 1);
    next.splice(newIndex, 0, moved);
    return next
}
