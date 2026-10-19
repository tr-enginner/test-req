import { z } from "zod"

export const CallGraph = z.record(z.string(), z.array(z.string()))
export type CallGraph = z.infer<typeof CallGraph>
