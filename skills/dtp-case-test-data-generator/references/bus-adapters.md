# BusAdapters

BusAdapters own deterministic behavior that differs by transport. The common pipeline owns document extraction, reference retrieval, protocol families and selectors, case iteration, generic mutations, file publication, and diagnostics.

Built-in adapters:

- `can`: primary/secondary CAN fallback policies, DLC cleanup, SJA1000/PeliCAN Frame Information, and documented fixed envelopes.
- `spi`: ADDRESS option selection, SPI fallback constraints, and SPI-specific plan validation.
- `spacewire`: block checksum algorithms and SpaceWire fallback constraints.
- `rs422`, `uart`, `1553b`: lightweight pass-through adapters that preserve bus detection and generic writing until dedicated protocol behavior is implemented.
- `generic`: conservative behavior for unsupported or unidentified buses.

Each Adapter carries its model fallback policy in code. The runtime must not read or create `.matrix/config/dtp-model-fallback-profiles.jsonc`. Adapter policy id, version, and hash remain in diagnostics and model-cache identity.

Use this order for case data:

1. Select a canonical protocol through the common protocol-family and selector pipeline.
2. Render canonical business bytes.
3. Apply generic semantic mutations and sequence operations.
4. Let the Adapter finalize bus-specific checksums.
5. Let the Adapter apply transport encoding or fixed envelopes.
6. Run common validation followed by Adapter validation.

Adding a bus requires an independent Adapter, registry entry, and regression tests. The adapter should first provide evidence matching; add interface classification, field resolution, checksum, transport, or validation hooks only when the bus needs them. Do not add a new `if (bus_type === ...)` branch to the common case-generation or writer orchestration.
