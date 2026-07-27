# Phase 191 — API Coverage Declaration

No external API integration: this phase adds one internal FastAPI endpoint (`GET /train/progress`) plus three additive columns on the project's own `train_settings` table (D-18), and reads the browser-native `Intl.DateTimeFormat` platform API for timezone capture — no third-party service, SDK, or remote API with a capability surface to enumerate.

## Detector note

`api-coverage.cjs` returned `detected: true` on two signals, both false positives for this checkpoint's purpose:

| Signal | Snippet | Why it is not an external API |
|--------|---------|-------------------------------|
| `consumes` / `endpoint` | "…it draws the same session-composition endpoint Phase 190 already consumes." | `POST /train/sessions` is a FlawChess-owned FastAPI route shipped in Phase 189. |
| `(surface)` / `api` | "Timezone is silently captured from the browser Intl API on every settings save" | `Intl.DateTimeFormat().resolvedOptions().timeZone` is an ECMA-402 browser built-in — no network call, no vendor, no versioned capability surface. |

Confirmed by re-reading the phase scope (`191-CONTEXT.md`, `191-RESEARCH.md`, ROADMAP Phase 191): zero new npm/pip dependencies, zero new external services (`191-RESEARCH.md` → Sources → Secondary: "this phase's research required no external documentation lookups (no new libraries, no new external services)").
