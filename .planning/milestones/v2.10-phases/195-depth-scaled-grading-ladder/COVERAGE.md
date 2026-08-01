# Phase 195 — API Coverage Declaration

No external API integration: Phase 195 is 100% client-side chess-engine work (a pure
TypeScript ladder module, the in-browser Stockfish WASM worker pool, the provider-agnostic
`mctsSearch` core) plus offline Node measurement harnesses (`scripts/*.mjs`) that drive the
same vendored Stockfish binary through stdin/stdout. It touches no HTTP client, no SDK, no
third-party service, no backend route, and adds no dependency to `package.json`. The only
"provider" nouns in scope (`EngineProviders`, `calibration-providers.mjs`,
`node-engine-providers.mjs`) are in-process function-shaped interfaces over local processes,
not remote APIs.

Verified by reading the phase scope: ROADMAP §"Phase 195", `195-CONTEXT.md` `<domain>`, and
`195-RESEARCH.md` § Architectural Responsibility Map ("No backend, database, or API surface is
touched by this phase").
