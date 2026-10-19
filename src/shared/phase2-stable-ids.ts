import { phase2Warning, reservedPhase2Ids } from "./phase2-tolerance"
export function assignStableRequirementIds<T extends { requirement_id?: string }>(
  rows: T[],
  prefix: string,
  reservedIds: string[] = reservedPhase2Ids(),
): Array<T & { requirement_id: string }> {
  const pattern = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-(\\d+)$`)
  const seen = new Set<string>(reservedIds)
  const accepted = new Set<number>()
  let next = 1
  for (const [index, row] of rows.entries()) {
    const id = row.requirement_id?.trim()
    if (!id) continue
    const match = id.match(pattern)
    if (!match || !Number.isSafeInteger(Number(match[1])) || Number(match[1]) < 1 || seen.has(id)) { phase2Warning(`需求编号 ${id} 已重新分配`); continue }
    accepted.add(index)
    seen.add(id)
    next = Math.max(next, Number(match[1]) + 1)
  }
  return rows.map((row, index) => {
    let id = accepted.has(index) ? row.requirement_id?.trim() : undefined
    if (!id) {
      do id = `${prefix}-${String(next++).padStart(3, "0")}`
      while (seen.has(id))
      seen.add(id)
    }
    return { ...row, requirement_id: id }
  })
}
