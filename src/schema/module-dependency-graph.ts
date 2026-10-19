import { z } from "zod"

export const ModuleDependencyGraph = z.record(z.string(), z.array(z.string()))
export type ModuleDependencyGraph = z.infer<typeof ModuleDependencyGraph>
