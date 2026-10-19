import { z } from "zod"

export const InspectorLocalSubgraphManifestEntry = z.object({
  context_id: z.string(),
  entry_name: z.string(),
  slicing_strategy: z.literal("local_subgraph"),
  block_kind: z.literal("local_subgraph"),
  file: z.string(),
}).strict()

export const InspectorLocalSubgraphManifest = z.object({
  project_path: z.string(),
  generated_at: z.string(),
  context_count: z.number().int().nonnegative(),
  contexts: z.array(InspectorLocalSubgraphManifestEntry),
}).strict().superRefine((manifest, ctx) => {
  if (manifest.context_count !== manifest.contexts.length) {
    ctx.addIssue({
      code: "custom",
      message: `context_count ${manifest.context_count} does not match contexts length ${manifest.contexts.length}`,
      path: ["context_count"],
    })
  }
})

export const InspectorLocalSubgraphFunctionLocation = z.object({
  name: z.string(),
  path: z.string(),
  start_line: z.number().int().positive(),
  end_line: z.number().int().positive(),
}).strict()

export const InspectorLocalSubgraphGlobalLocation = z.object({
  name: z.string(),
  path: z.string(),
  line: z.number().int().positive(),
}).strict()

export const InspectorLocalSubgraphTypeLocation = z.object({
  name: z.string(),
  path: z.string(),
  start_line: z.number().int().positive(),
  end_line: z.number().int().positive(),
}).strict()

export const InspectorLocalSubgraphMacroLocation = z.object({
  name: z.string(),
  path: z.string(),
  start_line: z.number().int().positive(),
  end_line: z.number().int().positive(),
  kind: z.enum(["object", "function"]),
}).strict()

export const InspectorLocalSubgraphAttachedCommentLocation = z.object({
  func_name: z.string(),
  path: z.string(),
  start_line: z.number().int().positive(),
  end_line: z.number().int().positive(),
}).strict()

export const InspectorLocalSubgraphContext = z.object({
  context_id: z.string(),
  block: z.object({
    block_id: z.string(),
    block_kind: z.literal("local_subgraph"),
    slicing_strategy: z.literal("local_subgraph"),
    root_function_name: z.string(),
    function_ids: z.array(z.number().int()),
  }).strict(),
  outline: z.object({
    globals: z.array(z.string()),
    types: z.array(z.string()),
    macros: z.array(z.string()).default([]),
    function_region: z.array(z.string()).min(1),
  }).strict(),
  locations: z.object({
    functions: z.array(InspectorLocalSubgraphFunctionLocation),
    globals: z.array(InspectorLocalSubgraphGlobalLocation),
    types: z.array(InspectorLocalSubgraphTypeLocation),
    macros: z.array(InspectorLocalSubgraphMacroLocation).default([]),
    attached_comments: z.array(InspectorLocalSubgraphAttachedCommentLocation).default([]),
  }).strict(),
  prompt_ready: z.object({
    text: z.string().min(1),
  }).strict(),
}).strict()

export type InspectorLocalSubgraphManifest = z.infer<typeof InspectorLocalSubgraphManifest>
export type InspectorLocalSubgraphManifestEntry = z.infer<typeof InspectorLocalSubgraphManifestEntry>
export type InspectorLocalSubgraphContext = z.infer<typeof InspectorLocalSubgraphContext>
