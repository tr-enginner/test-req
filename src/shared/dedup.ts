/**
 * Generic deduplication utility — keeps first occurrence by key.
 */
export function dedupeBy<T>(items: T[], keyFn: (item: T) => string): { items: T[]; removed: number } {
  const seen = new Set<string>()
  const result: T[] = []

  for (const item of items) {
    const key = keyFn(item)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(item)
  }

  return {
    items: result,
    removed: items.length - result.length,
  }
}
