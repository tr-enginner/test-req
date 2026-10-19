# Document References And Cache

## Discovery Boundary

- Source mode parses `.docx` only.
- A primary source filename must contain `第三方测试需求`.
- An external source is eligible only when the primary document explicitly references a requirement specification and the candidate filename identifies a requirement specification.
- Search only inside the current OpenCode workspace. `.matrix/reports` is eligible; `.matrix/data`, dependency folders, build output, and sibling workspaces are not.
- Do not follow references inside the referenced requirement specification. Record them as `not_followed_by_policy`.

## Exact Reference Resolution

Keep the complete locator, for example `表3.1.1.5-1`, `第3.1.2节`, or `附录K`.

- Table references match normalized complete aliases exactly.
- Section and appendix references match the extracted heading identifier exactly.
- Multiple equal document matches are `ambiguous`; do not select the first file.
- A missing requirement specification may fall back to the same exact target in the primary third-party requirement, with `fallback_resolved` and a warning.
- Unsupported external document types and names remain diagnostic references and are not parsed.

The resolved nodes and edges are written to `.matrix/data/dtp-generation/document-reference-graph.json`.

## Dependency Closure And Roles

Protocol context follows resolved references with a bounded, cycle-safe traversal. A direct reference may therefore bring in a frame table whose cells reference a field dictionary or checksum table. Requirement-specification documents remain one-hop sources: references found inside them are recorded but never followed.

Each resolved edge carries one or more advisory roles:

- `frame_layout`
- `field_dictionary`
- `payload_definition`
- `selector`
- `checksum_definition`
- `related_transport`
- `unknown`

Exact reference targets are determined by code. Roles organize evidence for the model but never authorize copying bytes across incompatible bus, interface, or business-entity scopes.

Protocol-to-source traceability is written to `.matrix/data/dtp-generation/protocol-evidence-trace.json`. It records source documents, sections, tables, resolved references, and warnings for each canonical protocol.

## Reference Dependency Closure

Protocol context is assembled from a bounded reference closure rather than direct references only.

- Start from the selected section's snippets and tables.
- Follow resolved references originating from those snippets or tables.
- Add referenced sections, tables, and their resolved same-document dependencies.
- Stop after three graph-expansion rounds and de-duplicate visited edges to prevent cycles.
- Never follow references originating inside a referenced requirement specification.

Each resolved reference is labelled with one or more advisory roles: `frame_layout`, `field_dictionary`, `payload_definition`, `selector`, `checksum_definition`, or `related_transport`. Exact reference edges take priority over adjacent or name-similar evidence, but incompatible bus/interface evidence must remain unresolved rather than being copied into another protocol family.

Compiled protocol provenance and the references that contributed to it are written to `.matrix/data/dtp-generation/protocol-evidence-trace.json`.

## Extraction Cache

Raw DOCX text and structure-preserving HTML are cached under `.matrix/data/dtp-generation/document-cache/` using the source content hash plus extractor version. Repeated source runs reuse unchanged documents. Changing one document invalidates only that document extraction and downstream protocol compilation.

## Table Evidence

The local knowledge index may retain `table_html`, normalized rows, and cell coordinates for deterministic processing. The model payload must not duplicate all three forms:

- frame-format tables are sent completely
- small tables are sent completely
- large support/dictionary tables use `table_html` with header rows, query-matched rows, and merged-cell anchor rows
- if HTML is unavailable, normalized selected rows are the fallback

Selected source row indexes remain in the payload for traceability.

## Portable Offline Package

`.matrix/data/dtp-generation/knowledge-package-manifest.json` records relative artifact paths, sizes, and SHA-256 hashes for source-mode packaging and diagnostics. Offline mode is trusted reuse: it does not enforce the embedded portable hash or manifest SHA-256 values and never scans source documents. Missing or mismatched manifest metadata produces a warning; only a missing, malformed, or evidence-empty `project-knowledge-index.json` blocks reuse.
