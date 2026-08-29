# Phase 213: First-Run Engine Cold Start — Asset-Check Gate & Download Progress UI - Context

**Gathered:** 2026-08-28
**Status:** Ready for planning

<domain>
## Phase Boundary

Frontend-only. Whenever an engine is used — Stockfish, Maia, or the combined FlawChess
engine — the consumer first checks that the device can run it and that every model/asset
it needs is present, downloading what is missing behind a progress UI. Bot play
additionally gates the game start on that readiness via the existing `confirmLive()` seam,
so a bot game never runs a clock against an engine that does not yet exist. The analysis
board gets the same progress UI but no gate (it has no clock). Persona avatars ship at
~128px with lazy loading.

No schema change, no new backend surface, no calibration risk.

**Out of scope** (locked in SEED-155, unchanged): INT8 model shrink (moves the policy
distribution, invalidates the 24-persona calibration); bullet time controls (collides with
`REVEAL_DELAY_MIN_MS` and `FLAWCHESS_BOT_MAX_NODES` — its own scope); the server-side
engine option; ONNX response compression (~8.5% on fp16). Adaptive prefetch is now also
out of scope — see D-04.

</domain>

<decisions>
## Implementation Decisions

### Readiness definition

- **D-01: Readiness = model bytes downloaded + ONNX session created.** Concretely, the
  `{ type: 'ready', backend }` message the worker already posts (`maia-worker.js:305`),
  surfaced to consumers. Nothing more. — **Reversibility:** reversible — a local
  definition consumed by the gate; tightening it later is a one-site change.

- **D-02: No warmup inference is added. This SUPERSEDES SEED-155's conditional-warmup lock ("warmup before the game, conditional on <~1s").** Rationale established during
  discussion:
  - The WebGPU branch's `await analyze(WARMUP_FEN, [WARMUP_ELO])`
    (`maia-worker.js:197`) exists for **failure detection, not latency** — WebGPU compiles
    compute shaders lazily on first run, so a broken session (Firefox/Windows `Clip`
    shader) passes `create()` and only throws on the first real `analyze()`. It stays
    exactly where it is, inside the `try` around `create()`, unmoved and unhoisted. Its
    "KEEP this call" comment stands.
  - The WASM branch has no lazy-shader-compile failure mode, so a WASM warmup would buy
    only latency — and a pre-game warmup does not remove that cost, it **relocates** it
    from the bot's clock to the user's wait. Against the 3+0 minimum preset (180s), one
    cold inference is noise; the 45.7 MB download is the whole problem. Pre-warming to
    protect the bot's clock only pays under bullet, which is out of scope.
  - **Consequences that dissolve:** the `<~1s` threshold, the "measure cold
    first-inference on a weak device" task, and the **entire finding-4 opening-book
    fork**. `resolveBookMove` (`useBotGame.ts:457`) calling `policy()` was only a problem
    if the game starts before the engine is usable. Under D-01 it is usable. **No
    policy-free ECO book fallback is to be built.**
  - Accepted asymmetry: WebGPU devices pay the warmup inference before `ready` fires
    (it is inside `initSession`), WASM devices do not — so WASM reaches ready *sooner*.
    Harmless; do not equalize.
  — **Reversibility:** reversible — adding a warmup later is additive.

- **D-03: `pool.warm()` / `queue.warm()` are NOT warmups** and are unaffected by D-02.
  They forward to `ensureSpawned()` / `ensureLease()` — they spawn the worker and start
  the asset load, i.e. they are the download trigger. They stay. Per SEED-155 finding 3,
  gate the `pool.warm()` **call** for blend-0 personas, never the `[]`-deps effect
  (`useBotGame.ts:1310-1311`), which is load-bearing per Phase 170 D-03.

### Gate behaviour

- **D-04: The tap-to-begin gate is cache-miss based, with no timer.** Gate iff the model
  actually had to be downloaded; if the assets were already present, go live silently. The
  "cached but slow" hole that made a timer attractive largely closed when D-02 dropped
  warmup — ready-time is now essentially download-time. Accepted residual: a cached-asset
  phone still spends ~1-3s parsing 45.7 MB of fp16 weights into the WASM heap and will
  auto-start; nobody looks away for 2s, so no away-time is billed in practice.
  Rejected: a `READY_GATE_THRESHOLD_MS` elapsed-wait constant; always-gate.
  — **Reversibility:** reversible — swapping to an elapsed-time rule is a local predicate
  change in one component.

- **D-05: Fresh games mount gated exactly as resumed games do**, reusing `confirmLive()`
  (`useBotGame.ts:683`) rather than inventing a second start path. `useBotGame.ts:664`
  (`useState(resume === undefined)`) becomes readiness-aware. Generalizes Phase 170's own
  stated principle, *"nobody pays for the engine cold-start"* (`useBotGame.ts:65`), from
  the resume case to every case.

- **D-06: Readiness is per-persona, not global** (locked in SEED-155, unchanged). Ready
  means Maia only when `blend <= 0` (rungs 800/1000/1200/1400 per `RUNG_BLEND`,
  `personaRegistry.ts:115-118`), Maia + Stockfish otherwise. A blend-0 game must never wait
  on 7.3 MB of Stockfish it can never use.

- **D-07: An in-flight fetch runs to completion and outlives the component.** Leaving
  /bots or switching persona mid-download does not abort it. Rationale: a partial download
  is worthless (the HTTP cache will not keep it), so aborting means the next attempt
  restarts from zero. Costs bandwidth if the user truly left the app; accepted.
  — **Reversibility:** reversible — adding an `AbortController` later is additive.

- **D-08: Adaptive prefetch is deferred to its own seed.** The gate is correct without it,
  D-02 already shrank the phase, and the telemetry in D-16/D-17 should inform whether
  spending 45.7 MB of a user's mobile data speculatively is worth it. Do not build the
  `saveData` / `effectiveType` trigger in this phase.

### Progress UI

- **D-09: One non-dismissible `Dialog` with two states** — "downloading" (progress) then
  "ready" (a Start button wired to `confirmLive()`). Mirrors `ResumeGate.tsx` and renders
  as its direct sibling in `Bots.tsx:563` (`resume === null && !game.live`, where
  ResumeGate is `resume !== null && !game.live`). One component, one seam.
  Rejected: inline on `SetupScreen`; a non-modal board overlay.

- **D-10: Readout is bar + percent + asset name** — e.g. "Maia model — 42%". No MB
  counter. A `progress` primitive does not exist in `components/ui/` and must be added.

- **D-11: Multi-asset downloads show one aggregate byte-weighted bar with changing subtext** naming the asset currently in flight — not per-asset rows. Honest, since Maia
  is ~86% of the bytes; per-asset rows would over-weight the 7.3 MB Stockfish next to the
  45.7 MB model. Note the multi-asset case is the less common one: blend-0 personas (the
  first-timer default) only ever download Maia.

- **D-12: On the analysis board, progress renders inside the existing skeleton slots** —
  `analysis-engine-loading` and `analysis-flawchess-loading` (`Analysis.tsx:3459`, `:3567`)
  plus the Maia panel — augmenting/replacing `EngineLinesSkeleton`. No new page-level
  surface, no banner. Respects the existing `loading → off → lines` branch pattern **and
  its mobile mirror** (`mobileEngineLines`, `Analysis.tsx:3566`) per the frontend
  mobile-parity rule.

### Failure & terminal states

- **D-13: A WASM-SIMD capability probe runs BEFORE the fetch starts.** A cheap
  `WebAssembly.validate()` of a tiny SIMD module. Today a device that can never run Maia
  downloads all 45.7 MB on mobile data before failing. "Check the assets are available"
  extends to "check this device can run them". **No SIMD detection exists anywhere in the
  codebase today** — this is new work.
  — **Reversibility:** reversible — a pure pre-check with no persisted state.

- **D-14: Two distinct terminal states, not one.**
  - **"Unsupported device"** — honest dead end, **no retry affordance**, points the user
    at what still works (analysis board, imports).
  - **"Engine failed to start"** — retry offered.

  These are genuinely two populations (see the project memory note "Maia iOS: two failure
  populations"): no-SIMD can never work; OOM / worker death often works on retry. Offering
  Retry on the first is a lie. Do NOT reuse the canonical `LoadError` component's mandated
  copy here — "Please try again in a moment" is wrong for a permanently incapable device.

- **D-15: A mid-fetch download failure auto-retries once, then surfaces a manual Retry button.** One silent retry covers the common transient drop; a second failure needs
  consent, because each retry re-downloads 45.7 MB from scratch (no resumable partial).

### Telemetry

- **D-16: Umami — gate shown + wait duration, and abandonment during the wait.** Real
  wait times on real devices are exactly "what the browser knows and the database cannot"
  (`frontend/CLAUDE.md`). There is no data on this today beyond one first-time user's
  report. Abandonment is the bounce signal this phase exists to fix. Follow the Umami rules
  in `frontend/CLAUDE.md`: `trackEvent()` from `lib/analytics.ts` for non-`<a>` surfaces,
  never `data-umami-event` on an internal react-router `<Link>`.

- **D-17: Sentry — terminal failures only** (unsupported device / worker death /
  download failed), with device context. `maiaWorkerHost` already reports worker death;
  this adds the consumer-visible gate failure. Do not capture ordinary slow downloads.

### Avatars

- **D-18: Ship ~128px WebP with `loading="lazy"`; keep the 512×512 sources and any larger generation outputs.** Resize only what enters the frontend bundle. Today 24 files ×
  ~33 KB = 794 KB, eager-globbed (`personaAvatars.ts:56`, `eager: true`), rendered into a
  58px circle (`AVATAR_PX`, `PersonaCard.tsx:36`). Expect ~120 KB after. Regeneration path
  exists: `scripts/gen_persona_avatars.py` + `frontend/src/data/personaAvatarPrompts.md`.
  Fully independent of everything above — can ship in its own plan.

### Claude's Discretion

- The avatar resize pipeline itself: how the 128px variants are produced, where the 512×512
  sources live so Vite's glob does not bundle them, and whether the glob moves from `eager`
  to lazy. Locked outcome (D-18), open mechanism.
- Where the readiness surface physically lands. See the code-context note below —
  `maiaWorkerHost` already has most of it.
- Exact UI copy for the two terminal states (D-14), subject to the "no `LoadError` copy"
  constraint.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase source of truth
- `.planning/seeds/closed/SEED-155-first-run-engine-cold-start-ux.md` — the measured
  first-run cost table, all five findings, the "already handled — do not re-solve" list,
  and the bullet-TC constraints recorded but not folded in. **Read with D-02 in hand:**
  this CONTEXT supersedes the seed's conditional-warmup decision and its finding-4 book
  fork. Everything else in the seed stands.
- `.planning/ROADMAP.md` § "Phase 213" — goal, locked items, planning notes.

### Project rules
- `CLAUDE.md` — no magic numbers, function size limits, `Literal` over bare `str`,
  communication style.
- `frontend/CLAUDE.md` — theme constants in `theme.ts`, `noUncheckedIndexedAccess`, knip in
  CI, **`text-sm` minimum font size**, mobile-parity rule, Button variants (primary =
  `variant="default"`, secondary = `variant="brand-outline"`), Sentry rules, the Umami
  outbound/`trackEvent` rules, and the `data-testid` / semantic-HTML / ARIA browser
  automation requirements.

### Engine internals (the surfaces this phase changes)
- `frontend/src/lib/engine/maiaWorkerHost.ts` §61-78, §418-444 — the shared worker
  singleton. **Already publishes `whenReady(): Promise<'webgpu'|'wasm'>` and a per-lease
  `onFatal`.**
- `frontend/public/maia/maia-worker.js` §125-215, §300-325 — `initSession`, the WebGPU
  warmup (D-02), and the `ready` / `webgpu-unavailable` / `error` message protocol. The
  owned loader must add a progress message type here.
- `frontend/src/lib/engine/maiaQueue.ts` §57-90 — `MaiaQueue`'s public surface
  (`policy`/`terminate`/`warm`); `leaseReady`/`whenReady`/`onFatal` are module-internal.
- `frontend/src/lib/engine/workerPool.ts` §255-290 — `WorkerPool`'s public surface
  (`grade`/`stopAll`/`terminate`/`warm`).
- `frontend/src/lib/personas/personaRegistry.ts` §115-118 — `RUNG_BLEND`, the blend-0
  rung mapping that D-06 keys off.
- `frontend/src/lib/playStyle.ts` §25 — `HUMAN_BLEND = 0`.

### Consumers
- `frontend/src/hooks/useBotGame.ts` §65, §457, §664, §683, §1298-1320 — the cold-start
  principle comment, `resolveBookMove`, the `live` state, the `confirmLive()` seam, and the
  bring-up effect.
- `frontend/src/components/bots/ResumeGate.tsx` — the precedent for D-09 (non-dismissible
  `Dialog`, `showCloseButton={false}`, `onOpenChange={() => {}}`, testid conventions).
- `frontend/src/pages/Bots.tsx` §563 — where the new gate mounts as ResumeGate's sibling.
- `frontend/src/pages/Analysis.tsx` §1090-1094, §3459, §3567 — `engineLoading` /
  `flawChessLoading` and the desktop + mobile skeleton slots D-12 targets.
- `frontend/src/hooks/useMaiaEngine.ts` §338 — the model for consuming lease `onFatal`
  (CR-03 / SEED-113 / Phase 172).

### Already handled — do not re-solve
- `deploy/Caddyfile` §128 — `/maia/*` and `/engine/*` at `max-age=2592000`, deliberately
  not `immutable`.
- `frontend/vite.config.ts` §105 — `globIgnores` excludes `*.onnx` from the SW precache
  (iOS ~50 MB Cache API limit). Cloudflare CDN already fronts the model and avatars
  (`cf-cache-status: HIT` verified 2026-08-27).

### Avatars
- `frontend/src/lib/personas/personaAvatars.ts` §56 — the `eager: true` glob.
- `frontend/src/components/bots/PersonaCard.tsx` §36 — `AVATAR_PX = 58`.
- `scripts/gen_persona_avatars.py`, `frontend/src/data/personaAvatarPrompts.md` — the
  regeneration path.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets

- **`maiaWorkerHost.whenReady()` and per-lease `onFatal` already exist**
  (`maiaWorkerHost.ts:61-78`). SEED-155 consequence 2 says "neither provider exposes
  readiness — this is the main new surface"; that is true only of `MaiaQueue` and
  `WorkerPool`, which do not forward what the host already has. **This is a forwarding
  job, not a new state machine.** Do not rebuild a readiness mechanism.
- **`ResumeGate.tsx`** — a complete, tested precedent for a non-dismissible modal over a
  live board, including the discard-confirm sub-dialog pattern and testid naming. D-09's
  gate is its structural sibling.
- **`EngineLinesSkeleton`** — already occupies the analysis-board loading slots D-12
  targets, in both the desktop card and the mobile `mobileEngineLines` mirror.
- **`LoadError` (`components/ui/load-error.tsx`)** — the canonical data-load error, with
  mandated copy. Deliberately **not** reused for D-14; noted so nobody reaches for it.

### Established Patterns

- `useBotGame`'s `live` / `confirmLive()` state machine (Phase 170 D-03) is the whole gate
  mechanism; the phase adds a second reason for `live` to start false.
- The `loading → off → lines` ternary chain on Analysis, duplicated desktop/mobile — any
  change must be applied to both (frontend mobile-parity rule).
- The `[]`-deps bring-up effect in `useBotGame` is load-bearing (Phase 170 D-03 mechanism
  1: a resumed bot with 5s left must not flag on a worker spawn). Gate calls inside it,
  never the effect.

### Integration Points

- **New:** a progress message type in the `maia-worker.js` protocol, and a `progress`
  primitive in `components/ui/` (none exists).
- **New:** a WASM-SIMD probe (D-13) — nothing in the codebase detects SIMD today.
- **Changed:** `InferenceSession.create()` takes a `Uint8Array` buffer instead of
  `MODEL_PATH`, on **both** the WASM branch (`maia-worker.js:141`) and the WebGPU branch
  (`:189`).
- **Changed:** `MaiaQueue` and `WorkerPool` public interfaces gain readiness + fatal
  forwarding.
- **Changed:** `useBotGame.ts:664`'s `live` initializer, and the `pool.warm()` call site.
- **Changed:** `Bots.tsx:563` gains the sibling gate branch.

</code_context>

<specifics>
## Specific Ideas

- The originating report is concrete and should be the UAT scenario: a **guest account on
  an Android phone**, cold cache, starting a bot game — the bot took a very long time to
  play its first move and the persona images loaded slowly.
- SEED-155 finding 1 (a fresh game mounts `live: true` and burns the bot's clock through
  the whole download) is **NOT YET VERIFIED on a real device**. The arithmetic says a
  2 Mbps link (~183s for 45.7 MB) can flag the bot at 3+0 before move 1. Confirm before
  treating it as a bug — but note the fix is being made regardless, since D-05 gates the
  fresh path either way.
- The 45.7 MB is served **uncompressed** and is already fp16, so gzip buys only ~8.5%.
  Out of scope, but relevant if anyone wonders why the download is not being shrunk.

</specifics>

<deferred>
## Deferred Ideas

- **Adaptive prefetch** (`saveData` / `effectiveType`-aware early model fetch; candidate
  triggers earliest-first: `loginAsGuest` at `useAuth.ts:146`, /bots mount, persona select,
  Start). Demoted by SEED-155 to a pure optimization and deferred out of this phase by
  D-08. Should become its own seed, informed by the D-16 wait-duration telemetry.
- **Bullet time controls** — SEED-155 records why bullet collides with
  `REVEAL_DELAY_MIN_MS`/`REVEAL_DELAY_MAX_MS` (`chessClock.ts:75,79`) and
  `FLAWCHESS_BOT_MAX_NODES` (D-07/D-19), and that mid-game worker respawn becomes fatal at
  1+0. Note the interaction with D-02: **under bullet the dropped warmup would have to come
  back**, since there is no clock room to warm mid-game. Its own scope.
- **INT8 model shrink** — would invalidate the 24-persona calibration fit. Out.
- **Server-side engine option** — deliberately deferred, scoped separately in the seed.
- **ONNX response compression** — ~8.5% on fp16. Lowest priority.

### Reviewed Todos (not folded)

The `todo.match-phase` scan returned 3 matches, all keyword false positives with no
relation to this phase:
- `2026-05-18-wr01-pt33-invalid-tailwind-score-axis-label.md` — a Tailwind class fix on a
  chart axis label. Matched only on "frontend".
- `172-deferred-review-findings.md` — Phase 172 gem-sweep review leftovers. Matched on
  generic words ("status", "phase", "deferred").
- `2026-03-11-bitboard-storage-for-partial-position-queries.md` — a database concern.
  Matched on "game"/"games".

</deferred>

---

*Phase: 213-first-run-engine-cold-start-ux*
*Context gathered: 2026-08-28*

- **D-18 (added 2026-08-29, user decision during UAT): the analysis gate closes itself;
  bot play keeps its Start button.** On the analysis surface the readiness gate now
  auto-closes the moment the engine is genuinely ready, with no modal footer and no
  Start button — the user has already chosen to analyse a game, so a second
  confirmation is friction. On the bots surface the modal and its Start button stay:
  starting a bot game is a deliberate act and the gate is where the user picks their
  moment. Auto-close fires on the same `assets.ready` signal that enables Start, never
  on last-byte, so G-213-19's `Download complete. Starting the engine...` state stays
  reachable on analysis. The started telemetry event gains a trigger discriminator so
  G-213-34's per-surface funnel does not read auto-closes as clicks.
  — **Reversibility:** reversible — one effect plus one conditional render, both keyed
  on the existing `surface` prop. Partially supersedes D-09 (one Dialog, two states)
  for the analysis surface only.

- **D-20 (added 2026-08-29, user decision after G-213-37 triage): the Cache API
  (CacheStorage) becomes the single byte-ownership layer for ALL engine assets —
  Maia model, ORT runtime, Stockfish wasm.** The phase promised "download once, zero
  refetches across surfaces" while the engine lifecycle deliberately frees everything
  at zero leases (the FLAWCHESS-92 mobile-OOM policy); the only reconciliation was the
  HTTP cache, which UAT's "Disable cache" removes. The per-asset in-memory patches
  (213-08 shared Stockfish fetch, G-213-8 modelBuffer handoff, 213-11 ORT
  retain-and-copy) each covered one path and left the largest asset — the 45.7 MB
  model, fetched only inside the worker — with no cache at all; G-213-37 is that hole.
  CacheStorage resolves the contradiction: disk-backed (no main-thread RAM retention,
  no OOM regression), available inside DedicatedWorkerGlobalScope (the worker can read
  it directly), and NOT bypassed by DevTools "Disable cache", so the zero-refetch
  criterion becomes honestly measurable. Consequences: the ortRuntimeSource in-memory
  master and the modelBuffer respawn handoff become removable (respawns read from
  cache); a cache version constant governs invalidation since public/ engine assets
  are not content-hashed; feature-detect `caches` and fall back to today's plain fetch
  where unavailable (Safari private mode, insecure contexts). localStorage seen-flags
  stay the synchronous gate predicate (D-04) unchanged.
  — **Reversibility:** reversible but wide — touches all three fetch sites; the
  fallback path IS the old behavior, so removal is a deletion, not a rewrite.
